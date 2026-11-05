import type { ConversationId } from "@earendil-works/pi-durable";
import type { PublishedHookCall } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishedHooks } from "../src/hooks.js";
import { answer, raise } from "../src/lifecycle.js";
import { EscalationStore } from "../src/store.js";
import type { Bucket, Escalation } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const JOB = "ext:acme:cleanup";
const hosts: FakeHost[] = [];

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const host = await createFakeHost({
		users: [{ user: "alice", admin: true }, { user: "bob", admin: false }],
		...opts,
	});
	hosts.push(host);
	return host;
}

function setup(host: FakeHost) {
	const store = new EscalationStore(host);
	const hooks = createPublishedHooks({ host, store, now: () => NOW });
	const byName = (name: string) => {
		const hook = hooks.find((candidate) => candidate.name === name);
		if (hook === undefined) throw new Error(`missing hook ${name}`);
		return hook;
	};
	return { store, raiseHook: byName("escalation.raise"), takeHook: byName("escalation.take"), resolveHook: byName("escalation.resolve") };
}

function call(conversationId: ConversationId | undefined, user = "alice"): PublishedHookCall {
	return { caller: "acme", user, conversationId, abortSignal: undefined };
}

const RAISE_PAYLOAD = {
	key: "acme-key",
	title: "Disk needs attention",
	body: "The nightly check found that the disk is nearly full.",
	options: [{ id: "retry", label: "Retry the check" }],
};

interface RaiseResult { id: string; created: boolean; status: string }
interface TakeResult { status: string; id?: string; option?: string }

async function items(store: EscalationStore, bucket: Bucket): Promise<Escalation[]> {
	return await store.list(bucket);
}

async function seedAnswered(
	store: EscalationStore,
	bucket: Bucket,
	namespace: string,
	key: string,
): Promise<Escalation> {
	const opened = raise(
		{
			owner: bucket.kind === "user" ? bucket.user : undefined,
			namespace,
			key,
			title: "Disk needs attention",
			body: "The nightly check found that the disk is nearly full.",
			options: [{ id: "retry", label: "Retry the check" }],
			allowInstruction: true,
			onAnswer: "immediate",
			source: {},
		},
		NOW,
	);
	const answered = answer(opened, { option: "retry", by: "alice" }, NOW);
	await store.update(bucket, (existing) => ({
		items: [...existing, answered],
		result: undefined,
	}));
	return answered;
}

afterEach(async () => {
	while (hosts.length > 0) await hosts.pop()!.cleanup();
});

describe("published hooks", () => {
	it("raise creates once and dedups by namespace+key", async () => {
		const host = await fakeHost();
		const { store, raiseHook } = setup(host);
		const conversationId = await host.conversations.create({ owner: "alice" });

		const first = (await raiseHook.run(RAISE_PAYLOAD, call(conversationId))) as RaiseResult;
		expect(first.created).toBe(true);
		expect(first.status).toBe("open");

		const second = (await raiseHook.run(RAISE_PAYLOAD, call(conversationId))) as RaiseResult;
		expect(second).toEqual({ id: first.id, created: false, status: "open" });
		expect(await items(store, { kind: "user", user: "alice" })).toHaveLength(1);
		const notifies = host.calls.filter((entry) => entry.method === "notify");
		expect(notifies).toHaveLength(1);
	});

	it("raise with jobId uses namespace job:<jobId> even when meta has no jobId", async () => {
		const host = await fakeHost();
		const { store, raiseHook } = setup(host);
		const conversationId = await host.conversations.create({ owner: "alice" });

		const jobResult = (await raiseHook.run(
			{ ...RAISE_PAYLOAD, jobId: JOB, onAnswer: "next-run" },
			call(conversationId),
		)) as RaiseResult;
		expect(jobResult.created).toBe(true);

		const userResult = (await raiseHook.run(RAISE_PAYLOAD, call(conversationId))) as RaiseResult;
		expect(userResult.created).toBe(true);
		expect(userResult.id).not.toBe(jobResult.id);

		const stored = await items(store, { kind: "user", user: "alice" });
		expect(stored).toHaveLength(2);
		expect(stored.find((item) => item.id === jobResult.id)?.namespace).toBe(`job:${JOB}`);
		expect(stored.find((item) => item.id === userResult.id)?.namespace).toBe("user");
	});

	it("take on an open item returns open and claims nothing", async () => {
		const host = await fakeHost();
		const { store, raiseHook, takeHook } = setup(host);
		const conversationId = await host.conversations.create({ owner: "alice" });
		await raiseHook.run(RAISE_PAYLOAD, call(conversationId));

		const result = (await takeHook.run({ key: "acme-key" }, call(conversationId))) as TakeResult;
		expect(result.status).toBe("open");

		const [stored] = await items(store, { kind: "user", user: "alice" });
		expect(stored?.status).toBe("open");
		expect(stored?.claim).toBeUndefined();
	});

	it("take on an answered item claims it for the calling conversation", async () => {
		const host = await fakeHost();
		const { store, takeHook } = setup(host);
		const conversationId = await host.conversations.create({ owner: "alice" });
		const seeded = await seedAnswered(store, { kind: "user", user: "alice" }, "user", "acme-key");

		const result = (await takeHook.run({ key: "acme-key" }, call(conversationId))) as TakeResult;
		expect(result).toEqual({ status: "claimed", id: seeded.id, option: "retry" });

		const [stored] = await items(store, { kind: "user", user: "alice" });
		expect(stored?.status).toBe("claimed");
		expect(stored?.claim?.conversationId).toBe(conversationId);
	});

	it("take is idempotent for the same conversation and reports the status to another", async () => {
		const host = await fakeHost();
		const { store, takeHook } = setup(host);
		const aliceConv = await host.conversations.create({ owner: "alice" });
		const otherConv = await host.conversations.create({ owner: "alice" });
		const seeded = await seedAnswered(store, { kind: "user", user: "alice" }, "user", "acme-key");

		const first = (await takeHook.run({ key: "acme-key" }, call(aliceConv))) as TakeResult;
		expect(first.status).toBe("claimed");
		const again = (await takeHook.run({ key: "acme-key" }, call(aliceConv))) as TakeResult;
		expect(again).toEqual(first);

		const other = (await takeHook.run({ key: "acme-key" }, call(otherConv))) as TakeResult;
		expect(other).toEqual({ status: "claimed", id: seeded.id, option: "retry" });

		const [stored] = await items(store, { kind: "user", user: "alice" });
		expect(stored?.claim?.conversationId).toBe(aliceConv);
	});

	it("resolve done after take resolves; resolve from another conversation fails wrong_claimant", async () => {
		const host = await fakeHost();
		const { store, takeHook, resolveHook } = setup(host);
		const aliceConv = await host.conversations.create({ owner: "alice" });
		const otherConv = await host.conversations.create({ owner: "alice" });
		const seeded = await seedAnswered(store, { kind: "user", user: "alice" }, "user", "acme-key");
		await takeHook.run({ key: "acme-key" }, call(aliceConv));

		await expect(
			resolveHook.run({ id: seeded.id, outcome: "done" }, call(otherConv)),
		).rejects.toThrow("wrong_claimant");

		const result = (await resolveHook.run(
			{ id: seeded.id, outcome: "done" },
			call(aliceConv),
		)) as { status: string };
		expect(result.status).toBe("resolved");

		const [stored] = await items(store, { kind: "user", user: "alice" });
		expect(stored?.status).toBe("resolved");
	});

	it("all three hooks throw without a conversationId", async () => {
		const host = await fakeHost();
		const { raiseHook, takeHook, resolveHook } = setup(host);
		await expect(raiseHook.run(RAISE_PAYLOAD, call(undefined))).rejects.toThrow(
			"escalation hooks need a conversation",
		);
		await expect(takeHook.run({ key: "acme-key" }, call(undefined))).rejects.toThrow(
			"escalation hooks need a conversation",
		);
		await expect(resolveHook.run({ id: "x", outcome: "done" }, call(undefined))).rejects.toThrow(
			"escalation hooks need a conversation",
		);
	});
});
