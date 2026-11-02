import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type {
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SessionMeta } from "@sigrun/shared/session-meta";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Value } from "typebox/value";
import {
	answer,
	claim,
	dismiss,
	raise,
	resolve,
	snooze,
} from "../src/lifecycle.js";
import { INBOX_TABS, inboxKeys } from "../src/keys.js";
import { notifyOrphaned } from "../src/notify.js";
import { EscalationStore, bucketFor } from "../src/store.js";
import { createTools } from "../src/tools.js";
import type { Bucket, Escalation, EscalationOption } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const ALICE: Bucket = { kind: "user", user: "alice" };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const OPTIONS: EscalationOption[] = [
	{ id: "retry", label: "Retry the check", detail: "Run it again" },
	{ id: "ignore-path", label: "Ignore this path" },
];
const hosts: FakeHost[] = [];

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const host = await createFakeHost(opts);
	hosts.push(host);
	return host;
}

function meta(owner: string | undefined, source: string, jobId?: string): SessionMeta {
	return {
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source,
		...(owner === undefined ? {} : { owner }),
		...(jobId === undefined ? {} : { jobId }),
	};
}

async function rig(opts: FakeHostOptions = { users: [{ user: "alice", admin: false }] }) {
	const host = await fakeHost(opts);
	const store = new EscalationStore(host);
	const tools = createTools({ host, store, now: () => NOW });
	const call = async (
		name: string,
		conversationId: number,
		args: Record<string, unknown> = {},
	): Promise<ToolExecutionResult> => {
		const tool = tools.find((candidate) => candidate.name === name);
		if (tool === undefined) throw new Error(`missing tool ${name}`);
		return await tool.execute(
			args,
			{ conversationId, callId: "call-1" } as ToolExecutionApi,
			BACKGROUND_CONTEXT,
		);
	};
	return { host, store, tools, call };
}

function output(result: ToolExecutionResult): string {
	return result.output?.[0]?.type === "text" ? result.output[0].text : "";
}

function structured<T>(result: ToolExecutionResult): T {
	return result.structuredOutput as T;
}

function setMeta(host: FakeHost, conversationId: number, value: SessionMeta): void {
	host.setMeta(conversationId as ConversationId, value);
}

function escalationArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		key: "disk:/srv/a",
		title: "Disk needs attention",
		body: "The nightly check found that the disk is nearly full.",
		options: OPTIONS,
		...overrides,
	};
}

function seeded(
	id: string,
	key: string,
	status: Escalation["status"],
	overrides: Partial<Escalation> = {},
): Escalation {
	let item = raise(
		{
			owner: "alice",
			namespace: "job:api:1",
			key,
			title: `Decision for ${key}`,
			body: `Evidence and proposed action for ${key}.`,
			options: OPTIONS,
			allowInstruction: true,
			onAnswer: "next-run",
			source: { jobId: "api:1", conversationId: 1 },
		},
		NOW,
	);
	item = { ...item, id };
	if (status === "answered" || status === "claimed") {
		item = answer(item, { option: "retry", by: "alice" }, NOW);
	}
	if (status === "claimed") item = claim(item, 10, NOW);
	if (status === "dismissed") item = dismiss(item, NOW);
	if (status === "snoozed") item = snooze(item, 1, NOW);
	return { ...item, ...overrides };
}

async function seed(store: EscalationStore, items: readonly Escalation[]): Promise<void> {
	await store.update(ALICE, (existing) => ({
		items: [...existing, ...items],
		result: undefined,
	}));
}

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

describe("tool contracts", () => {
	it("declares replay safety and schemas matching every successful structured result", async () => {
		const { host, store, tools, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		await seed(store, [seeded("act-1", "disk:/srv/a", "answered")]);
		expect(tools.map((tool) => tool.name)).toEqual([
			"escalate",
			"escalation_list",
			"escalation_resolve",
		]);
		for (const tool of tools) {
			expect(tool.replay).toBe("safe");
			expect(tool.structuredOutputSchema).toBeDefined();
		}

		const raised = await call("escalate", 10, escalationArgs({ key: "disk:/srv/b" }));
		const listed = await call("escalation_list", 10);
		const resolved = await call("escalation_resolve", 10, {
			id: "act-1",
			outcome: "done",
			note: "Retried successfully",
		});
		for (const [tool, result] of [
			[tools[0], raised],
			[tools[1], listed],
			[tools[2], resolved],
		] as const) {
			expect(Value.Check(tool.structuredOutputSchema as TSchema, result.structuredOutput)).toBe(true);
		}
		for (const result of [raised, listed, resolved]) expect(result.isError).toBeUndefined();
	});

	it("rejects a malformed option id and nine options through the real argument validator", async () => {
		const { tools } = await rig();
		const escalate = tools[0] as ToolRegistration;
		for (const args of [
			escalationArgs({ options: [{ id: "Bad Id", label: "Bad" }] }),
			escalationArgs({
				options: Array.from({ length: 9 }, (_, index) => ({
					id: `option-${index}`,
					label: `Option ${index}`,
				})),
			}),
		]) {
			expect(() =>
				validateToolArguments(escalate, {
					id: "call-1",
					name: "escalate",
					type: "toolCall",
					arguments: args as Parameters<typeof validateToolArguments>[1]["arguments"],
				}),
			).toThrow(/Validation failed for tool "escalate"/);
		}
	});
});

describe("escalate", () => {
	it("raises in the job namespace, notifies alice, and invalidates every inbox key", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));

		const result = await call("escalate", 10, escalationArgs());

		expect(output(result)).toBe(`Escalation ${structured<{ id: string }>(result).id} raised.`);
		expect(structured(result)).toEqual({
			id: expect.any(String),
			created: true,
			status: "open",
		});
		const items = await store.list(ALICE);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({
			owner: "alice",
			namespace: "job:api:1",
			key: "disk:/srv/a",
			onAnswer: "next-run",
			status: "open",
			allowInstruction: true,
			source: { jobId: "api:1", conversationId: 10 },
		});
		const notices = host.calls.filter((entry) => entry.method === "notify");
		expect(notices).toHaveLength(1);
		expect(notices[0]?.args[0]).toMatchObject({
			user: "alice",
			kind: "escalation.raised",
			title: "Needs your decision: Disk needs attention",
			body: "The nightly check found that the disk is nearly full.",
			target: { view: "inbox", params: { id: items[0]?.id } },
		});
		expect(INBOX_TABS).toEqual(["open", "active", "dismissed", "resolved"]);
		expect(inboxKeys(items[0]?.id)).toEqual([
			"{}",
			"{\"tab\":\"open\"}",
			"{\"tab\":\"active\"}",
			"{\"tab\":\"dismissed\"}",
			"{\"tab\":\"resolved\"}",
			`{"id":${JSON.stringify(items[0]?.id)}}`,
		]);
		expect(
			host.calls
				.filter((entry) => entry.method === "surfaces.changed")
				.map((entry) => entry.args[1]),
		).toEqual(inboxKeys(items[0]?.id));
	});

	it("dedups the same key without a second notification or changed inbox", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		const first = structured<{ id: string }>(
			await call("escalate", 10, escalationArgs()),
		);
		const before = host.calls.length;

		const second = await call("escalate", 10, escalationArgs({ title: "A new title" }));

		expect(structured(second)).toEqual({ id: first.id, created: false, status: "open" });
		expect(output(second)).toBe(
			`Escalation ${first.id} already exists (status open); not raised again.`,
		);
		expect(await store.list(ALICE)).toHaveLength(1);
		expect(host.calls.slice(before).filter((entry) => entry.method === "notify")).toHaveLength(0);
		expect(
			host.calls.slice(before).filter((entry) => entry.method === "surfaces.changed"),
		).toHaveLength(0);
	});

	it("allows the same key to raise again after resolution", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		const first = structured<{ id: string }>(
			await call("escalate", 10, escalationArgs()),
		);
		const bucket = await bucketFor(host, "alice");
		await store.update(bucket, (items) => ({
			items: items.map((item) =>
				item.id === first.id ? claim(answer(item, { option: "retry" }, NOW), 10, NOW) : item,
			),
			result: undefined,
		}));
		await store.update(bucket, (items) => ({
			items: items.map((item) =>
				item.id === first.id ? resolve(item, 10, "done", "Completed", NOW) : item,
			),
			result: undefined,
		}));

		const second = structured<{ id: string; created: boolean }>(
			await call("escalate", 10, escalationArgs()),
		);

		expect(second.created).toBe(true);
		expect(second.id).not.toBe(first.id);
		expect(await store.list(ALICE)).toHaveLength(2);
	});

	it("defaults a non-job conversation to immediate and pins the next-run error", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 20, meta("alice", "test"));

		const immediate = await call("escalate", 20, escalationArgs());
		expect((await store.list(ALICE))[0]).toMatchObject({
			namespace: "user",
			onAnswer: "immediate",
			source: { conversationId: 20 },
		});
		expect(structured(immediate)).toMatchObject({ created: true, status: "open" });

		const invalid = await call(
			"escalate",
			20,
			escalationArgs({ key: "disk:/srv/b", onAnswer: "next-run" }),
		);
		expect(invalid.isError).toBe(true);
		expect(invalid.structuredOutput).toBeUndefined();
		expect(output(invalid)).toBe("next-run needs a scheduled job run; use immediate");
		expect(await store.list(ALICE)).toHaveLength(1);
	});

	it("serializes ten concurrent raises into one item and one notification", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));

		const results = await Promise.all(
			Array.from({ length: 10 }, () => call("escalate", 10, escalationArgs())),
		);

		expect(results.filter((result) => structured<{ created: boolean }>(result).created)).toHaveLength(1);
		expect(new Set(results.map((result) => structured<{ id: string }>(result).id)).size).toBe(1);
		expect(await store.list(ALICE)).toHaveLength(1);
		expect(host.calls.filter((entry) => entry.method === "notify")).toHaveLength(1);
	});

	it("assigns an ownerless escalation to the primary admin and notifies only them", async () => {
		const { host, store, call } = await rig({
			users: [
				{ user: "root-admin", admin: true },
				{ user: "bob", admin: false },
			],
		});
		setMeta(host, 30, meta(undefined, "cron", "api:1"));

		const result = await call("escalate", 30, escalationArgs());
		const id = structured<{ id: string }>(result).id;

		const adminItems = await store.list({ kind: "user", user: "root-admin" });
		expect(adminItems).toHaveLength(1);
		expect(adminItems[0]).toMatchObject({ id, owner: "root-admin" });
		expect(await store.list({ kind: "user", user: "bob" })).toEqual([]);
		const notices = host.calls.filter((entry) => entry.method === "notify");
		expect(notices).toHaveLength(1);
		expect(notices[0]?.args[0]).toMatchObject({ user: "root-admin" });
	});
});

describe("notification edge cases", () => {
	it("truncates bodies and warns rather than throwing when notification delivery fails", async () => {
		const host = await fakeHost();
		const notices: unknown[] = [];
		host.notify = async (input) => {
			notices.push(input);
			throw new Error("notifier unavailable");
		};
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const item = seeded("orphan-1", "disk:/srv/a", "open", {
			owner: undefined,
			body: "x".repeat(250),
		});

		await expect(notifyOrphaned(host, item)).resolves.toBeUndefined();

		expect(notices).toHaveLength(1);
		expect(notices[0]).toEqual({
			user: undefined,
			kind: "escalation.orphaned",
			title: `Job deleted: ${item.title}`,
			body: "x".repeat(200),
			target: { view: "inbox", params: { id: item.id } },
		});
		expect(warning).toHaveBeenCalledOnce();
		warning.mockRestore();
	});
});

describe("escalation_list and escalation_resolve", () => {
	it("claims answered work only for a cron run and isolates other conversations", async () => {
		const { host, store, call } = await rig();
		await seed(store, [
			seeded("open-1", "disk:/srv/open", "open"),
			seeded("dismissed-1", "disk:/srv/dismissed", "dismissed"),
			seeded("snoozed-1", "disk:/srv/snoozed", "snoozed"),
			seeded("act-1", "disk:/srv/act", "answered"),
		]);
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		setMeta(host, 11, meta("alice", "cron", "api:1"));
		setMeta(host, 12, meta("alice", "escalations", "api:1"));

		const immediate = await call("escalation_list", 12);
		expect(structured(immediate)).toMatchObject({ act: [] });
		expect(structured<{ skip: string[] }>(immediate).skip).toEqual(
			expect.arrayContaining(["disk:/srv/open", "disk:/srv/dismissed", "disk:/srv/snoozed", "disk:/srv/act"]),
		);
		expect((await store.list(ALICE)).find((item) => item.id === "act-1")?.status).toBe("answered");

		const first = await call("escalation_list", 10);
		expect(structured(first)).toMatchObject({
			skip: ["disk:/srv/open", "disk:/srv/dismissed", "disk:/srv/snoozed"],
			act: [
				{
					id: "act-1",
					key: "disk:/srv/act",
					title: "Decision for disk:/srv/act",
					body: "Evidence and proposed action for disk:/srv/act.",
					options: OPTIONS,
					answer: expect.objectContaining({ option: "retry", by: "alice" }),
				},
			],
		});
		expect(output(first)).toContain("disk:/srv/open");
		expect(output(first)).toContain("Decision for disk:/srv/act");
		expect(output(first)).toContain("Evidence and proposed action for disk:/srv/act.");
		expect(output(first)).toContain("retry");
		expect((await store.list(ALICE)).find((item) => item.id === "act-1")).toMatchObject({
			status: "claimed",
			claim: { conversationId: 10 },
		});

		const other = await call("escalation_list", 11);
		expect(structured(other)).toMatchObject({ act: [] });
		expect(structured<{ skip: string[] }>(other).skip).toContain("disk:/srv/act");

		const again = await call("escalation_list", 10);
		expect(structured(again)).toEqual(structured(first));

		const wrong = await call("escalation_resolve", 11, {
			id: "act-1",
			outcome: "done",
			note: "Not this run",
		});
		expect(wrong.isError).toBe(true);
		expect(wrong.structuredOutput).toBeUndefined();
		expect(output(wrong)).toContain("wrong_claimant");

		const failed = await call("escalation_resolve", 10, {
			id: "act-1",
			outcome: "failed",
			note: "The retry failed",
		});
		expect(failed.isError).toBeUndefined();
		expect(structured(failed)).toEqual({ id: "act-1", status: "open" });
		expect(output(failed)).toBe("Escalation act-1 reopened (status open).");
		const reopenedItem = (await store.list(ALICE)).find((item) => item.id === "act-1");
		expect(reopenedItem).toMatchObject({ status: "open", reopenReason: "failed" });
		expect(reopenedItem?.answer).toBeUndefined();
		expect(reopenedItem?.claim).toBeUndefined();
		const reopened = host.calls.filter(
			(entry) =>
				entry.method === "notify" &&
				(entry.args[0] as { kind?: string }).kind === "escalation.reopened",
		);
		expect(reopened).toHaveLength(1);
		expect(reopened[0]?.args[0]).toMatchObject({
			user: "alice",
			title: "Back in your inbox: Decision for disk:/srv/act",
		});
	});

	it("returns not_claimed and unknown-id errors without writing", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		await seed(store, [seeded("open-1", "disk:/srv/open", "open")]);

		const notClaimed = await call("escalation_resolve", 10, {
			id: "open-1",
			outcome: "done",
			note: "Not claimed",
		});
		expect(notClaimed.isError).toBe(true);
		expect(output(notClaimed)).toContain("not_claimed");

		const missing = await call("escalation_resolve", 10, {
			id: "missing",
			outcome: "done",
			note: "Missing",
		});
		expect(missing.isError).toBe(true);
		expect(output(missing)).toContain("not_found");
		expect((await store.list(ALICE))[0]?.status).toBe("open");
	});

	it("resolves done and permits a later raise of the same key", async () => {
		const { host, store, call } = await rig();
		setMeta(host, 10, meta("alice", "cron", "api:1"));
		await seed(store, [seeded("act-1", "disk:/srv/act", "answered")]);
		await call("escalation_list", 10);

		const result = await call("escalation_resolve", 10, {
			id: "act-1",
			outcome: "done",
			note: "Completed",
		});
		expect(structured(result)).toEqual({ id: "act-1", status: "resolved" });
		expect(output(result)).toBe("Escalation act-1 resolved.");
		expect((await store.list(ALICE))[0]).toMatchObject({
			status: "resolved",
			resolvedAt: NOW.toISOString(),
		});
		const raised = await call("escalate", 10, escalationArgs({ key: "disk:/srv/act" }));
		expect(structured(raised)).toMatchObject({ created: true, status: "open" });
	});
});
