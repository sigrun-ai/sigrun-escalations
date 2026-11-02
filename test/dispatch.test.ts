import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readFile } from "node:fs/promises";
import type {
	ExtensionRunSettledHandler,
	HandlerContext,
	HostJobInfo,
	MemoryEventApi,
	RunSettledEvent,
} from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunSettled, seedText, startImmediateRun } from "../src/dispatch.js";
import { answer, claim, raise } from "../src/lifecycle.js";
import { EscalationStore } from "../src/store.js";
import type { Bucket, Escalation } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const ALICE: Bucket = { kind: "user", user: "alice" };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const hosts: FakeHost[] = [];

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const host = await createFakeHost(opts);
	hosts.push(host);
	return host;
}

function job(owner: string | undefined = "alice"): HostJobInfo {
	return { id: "api:1", name: "Nightly check", owner, enabled: true, state: "waiting" };
}

function immediate(id: string): Escalation {
	return {
		...raise(
			{
				owner: "alice",
				namespace: "job:api:1",
				key: "disk:/srv/a",
				title: "Disk needs attention",
				body: "The nightly check found that the disk is nearly full.",
				options: [{ id: "retry", label: "Retry the check" }],
				allowInstruction: true,
				onAnswer: "immediate",
				source: { jobId: "api:1" },
			},
			NOW,
		),
		id,
	};
}

async function seed(store: EscalationStore, items: readonly Escalation[]): Promise<void> {
	await store.update(ALICE, (existing) => ({
		items: [...existing, ...items],
		result: undefined,
	}));
}

function calls(host: FakeHost, method: string) {
	return host.calls.filter((call) => call.method === method);
}

async function settle(
	handler: ExtensionRunSettledHandler,
	conversationId: number,
): Promise<void> {
	const event = {
		conversationId,
		owner: "alice",
		inputs: [],
		inputTexts: [],
		outcome: { status: "unanswered", reason: "test" },
	} as unknown as RunSettledEvent;
	await handler(event, {} as MemoryEventApi, BACKGROUND_CONTEXT as HandlerContext);
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

describe("startImmediateRun", () => {
	it("claims and submits a job-scoped run using the job's current owner", async () => {
		const host = await fakeHost({ jobs: { "api:1": job() } });
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry", by: "alice" }, NOW);
		await seed(store, [item]);

		await expect(startImmediateRun({ host, store, now: () => NOW }, ALICE, item.id)).resolves.toBe(1);
		expect(calls(host, "conversations.create").map((call) => call.args[0])).toEqual([
			{
				owner: "alice",
				name: "Escalation: Disk needs attention",
				source: "escalations",
				job: "api:1",
			},
		]);
		expect((await store.list(ALICE))[0]).toMatchObject({
			status: "claimed",
			claim: { conversationId: 1, at: NOW.toISOString() },
		});
		const submits = calls(host, "conversations.submit");
		expect(submits).toHaveLength(1);
		expect(submits[0]?.args).toEqual([
			1,
			[{ type: "text", text: seedText(item, "Nightly check") }],
			undefined,
		]);
	});

	it("omits the job key when the job no longer exists", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		await seed(store, [item]);

		await expect(startImmediateRun({ host, store }, ALICE, item.id)).resolves.toBe(1);
		const input = calls(host, "conversations.create")[0]?.args[0] as Record<string, unknown>;
		expect(input).not.toHaveProperty("job");
		expect(calls(host, "conversations.submit")[0]?.args[1]).toEqual([
			{ type: "text", text: seedText(item) },
		]);
	});

	it("uses the job's current owner after a transfer", async () => {
		const host = await fakeHost({ jobs: { "api:1": job("bob") } });
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		await seed(store, [item]);

		await startImmediateRun({ host, store }, ALICE, item.id);
		expect(calls(host, "conversations.create")[0]?.args[0]).toMatchObject({
			owner: "bob",
			job: "api:1",
		});
	});

	it("leaves a lost claim unsubmitted and sends no notice", async () => {
		const host = await fakeHost({ jobs: { "api:1": job() } });
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		await seed(store, [item]);
		const originalUpdate = store.update.bind(store);
		vi.spyOn(store, "update").mockImplementation(async (bucket, update) => {
			await originalUpdate(bucket, (items) => ({
				items: items.map((candidate) =>
					candidate.id === item.id ? claim(candidate, 11, NOW) : candidate,
				),
				result: undefined,
			}));
			return originalUpdate(bucket, update);
		});

		await expect(startImmediateRun({ host, store }, ALICE, item.id)).resolves.toBeUndefined();
		expect(calls(host, "conversations.submit")).toEqual([]);
		expect(calls(host, "notify")).toEqual([]);
		expect((await store.list(ALICE))[0]?.claim?.conversationId).toBe(11);
	});

	it("releases and notifies when submit fails", async () => {
		const host = await fakeHost({ jobs: { "api:1": job() } });
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		await seed(store, [item]);
		vi.spyOn(host.conversations, "submit").mockRejectedValue(new Error("run refused"));

		await expect(startImmediateRun({ host, store }, ALICE, item.id)).resolves.toBeUndefined();
		const released = (await store.list(ALICE))[0];
		expect(released).toMatchObject({ status: "open", reopenReason: "interrupted" });
		expect(released?.answer).toBeUndefined();
		expect(released?.history.at(-1)).toMatchObject({
			event: "interrupted",
			note: "dispatch failed: run refused",
		});
		expect(calls(host, "notify").map((call) => call.args[0])).toEqual([
			expect.objectContaining({ kind: "escalation.reopened" }),
		]);
	});

	it("releases and notifies when create fails", async () => {
		const host = await fakeHost({ jobs: { "api:1": job() } });
		const store = new EscalationStore(host);
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		await seed(store, [item]);
		vi.spyOn(host.conversations, "create").mockRejectedValue(new Error("create refused"));

		await expect(startImmediateRun({ host, store }, ALICE, item.id)).resolves.toBeUndefined();
		expect((await store.list(ALICE))[0]?.history.at(-1)).toMatchObject({
			note: "dispatch failed: create refused",
		});
		expect(calls(host, "conversations.submit")).toEqual([]);
		expect(calls(host, "notify")).toHaveLength(1);
	});

	it("cuts the generated conversation name to 120 characters", async () => {
		const host = await fakeHost({ jobs: { "api:1": job() } });
		const store = new EscalationStore(host);
		const item = answer(
			{ ...immediate("act-1"), title: "x".repeat(200) },
			{ option: "retry" },
			NOW,
		);
		await seed(store, [item]);

		await startImmediateRun({ host, store }, ALICE, item.id);
		const input = calls(host, "conversations.create")[0]?.args[0] as { name: string };
		expect(input.name).toBe(`Escalation: ${"x".repeat(200)}`.slice(0, 120));
		expect(input.name).toHaveLength(120);
	});
});

describe("seedText", () => {
	it("renders an option-only answer exactly", () => {
		const item = answer(immediate("act-1"), { option: "retry" }, NOW);
		expect(seedText(item, "Nightly check")).toBe(
			'You are acting on an answered escalation (id act-1).\n\n' +
				'Title: Disk needs attention\n' +
				'Source: job "Nightly check" (api:1)\n\n' +
				'## Escalation\n' +
				'The nightly check found that the disk is nearly full.\n\n' +
				"## The user's answer\n" +
				'Chosen action: Retry the check (retry)\n' +
				'Instruction: none\n\n' +
				'Carry out the chosen action, following the instruction if one is given. When you are finished, call escalation_resolve with id "act-1", outcome "done" or "failed", and a short note. Do not raise a new escalation for this same issue.',
		);
	});

	it("renders an instruction-only answer exactly", () => {
		const item = answer(
			{ ...immediate("act-1"), source: { conversationId: 42 } },
			{ instruction: "Clean only the oldest files" },
			NOW,
		);
		expect(seedText(item)).toBe(
			'You are acting on an answered escalation (id act-1).\n\n' +
				'Title: Disk needs attention\n' +
				'Source: conversation #42\n\n' +
				'## Escalation\n' +
				'The nightly check found that the disk is nearly full.\n\n' +
				"## The user's answer\n" +
				'Chosen action: none chosen\n' +
				'Instruction: Clean only the oldest files\n\n' +
				'Carry out the chosen action, following the instruction if one is given. When you are finished, call escalation_resolve with id "act-1", outcome "done" or "failed", and a short note. Do not raise a new escalation for this same issue.',
		);
	});

	it("renders an absent source as none", () => {
		const item = answer({ ...immediate("act-1"), source: {} }, { option: "retry" }, NOW);
		expect(seedText(item)).toContain("\nSource: none\n");
	});
});

describe("createRunSettled", () => {
	it("writes nothing when the conversation holds no claims", async () => {
		const host = await fakeHost({ users: [{ user: "alice", admin: false }] });
		const store = new EscalationStore(host);
		await seed(store, [immediate("act-1")]);
		const before = await readFile(store.fileOf(ALICE), "utf8");
		const handler = createRunSettled({ host, store, now: () => NOW });

		await settle(handler, 10);
		expect(await readFile(store.fileOf(ALICE), "utf8")).toBe(before);
		expect(calls(host, "notify")).toEqual([]);
		expect(calls(host, "surfaces.changed")).toEqual([]);
	});

	it("releases only the settled conversation's claims and notifies for each", async () => {
		const host = await fakeHost({ users: [{ user: "alice", admin: false }] });
		const store = new EscalationStore(host);
		const first = claim(answer(immediate("act-1"), { option: "retry" }, NOW), 10, NOW);
		const second = claim(answer({ ...immediate("act-2"), key: "disk:/srv/b" }, { option: "retry" }, NOW), 10, NOW);
		const other = claim(answer({ ...immediate("act-3"), key: "disk:/srv/c" }, { option: "retry" }, NOW), 11, NOW);
		await seed(store, [first, second, other]);
		const handler = createRunSettled({ host, store, now: () => NOW });

		await settle(handler, 10);
		const items = await store.list(ALICE);
		expect(items.map((item) => [item.id, item.status, item.claim?.conversationId])).toEqual([
			["act-1", "open", undefined],
			["act-2", "open", undefined],
			["act-3", "claimed", 11],
		]);
		expect(items[0]?.history.at(-1)).toMatchObject({
			event: "interrupted",
			note: "run ended without resolving the escalation",
		});
		expect(calls(host, "notify").map((call) => call.args[0])).toEqual([
			expect.objectContaining({ kind: "escalation.reopened" }),
			expect.objectContaining({ kind: "escalation.reopened" }),
		]);
		expect(calls(host, "surfaces.changed")).toHaveLength(12);
	});

	it("resolves without throwing when the store read fails", async () => {
		const host = await fakeHost({ users: [{ user: "alice", admin: false }] });
		const store = new EscalationStore(host);
		vi.spyOn(store, "list").mockRejectedValue(new Error("read refused"));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const handler = createRunSettled({ host, store });

		await expect(settle(handler, 10)).resolves.toBeUndefined();
		expect(console.warn).toHaveBeenCalled();
	});
});
