import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HostJobInfo } from "@sigrun/sigrun/extension";
import { afterEach, describe, expect, it } from "vitest";
import { answer, claim, raise, snooze } from "../src/lifecycle.js";
import { EscalationStore } from "../src/store.js";
import { SWEEP_JOB, SWEEP_TASK_NAME, runSweep } from "../src/sweep.js";
import type { Bucket, Escalation } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const ALICE: Bucket = { kind: "user", user: "alice" };
const BOB: Bucket = { kind: "user", user: "bob" };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const DAY_MS = 86_400_000;
const hosts: FakeHost[] = [];

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const host = await createFakeHost(opts);
	hosts.push(host);
	return host;
}

function job(owner: string | undefined = "alice"): HostJobInfo {
	return {
		id: "nightly-check",
		name: "Nightly check",
		owner,
		enabled: true,
		state: "waiting",
	};
}

function item(id: string, jobId = "nightly-check"): Escalation {
	return {
		...raise(
			{
				owner: "alice",
				namespace: `job:${jobId}`,
				key: "disk:/srv/a",
				title: "Disk needs attention",
				body: "The nightly check found that the disk is nearly full.",
				options: [{ id: "retry", label: "Retry the check" }],
				allowInstruction: true,
				onAnswer: "next-run",
				source: { jobId },
			},
			NOW,
		),
		id,
	};
}

async function seed(
	store: EscalationStore,
	bucket: Bucket,
	items: readonly Escalation[],
): Promise<void> {
	await store.update(bucket, (existing) => ({
		items: [...existing, ...items],
		result: undefined,
	}));
}

function calls(host: FakeHost, method: string) {
	return host.calls.filter((call) => call.method === method);
}

function snoozed(id: string, until: Date): Escalation {
	const base = item(id);
	return {
		...base,
		status: "snoozed",
		snoozedUntil: until.toISOString(),
	};
}

function resolved(id: string, resolvedAt: Date): Escalation {
	const base = item(id);
	return { ...base, status: "resolved", resolvedAt: resolvedAt.toISOString() };
}

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

describe("runSweep", () => {
	it("exports the pinned task name and 15-minute sweep job", () => {
		expect(SWEEP_TASK_NAME).toBe("escalations.sweep");
		expect(SWEEP_JOB).toEqual({
			name: "sweep",
			schedule: { every: "15m" },
			action: { kind: "task", task: "escalations.sweep" },
		});
	});

	it("ends a snooze due now, notifies once, and leaves a later snooze untouched", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		const due = snoozed("due", NOW);
		const later = snoozed("later", new Date(NOW.getTime() + 1));
		await seed(store, ALICE, [due, later]);

		const report = await runSweep({ host, store, now: () => NOW });

		const items = await store.list(ALICE);
		expect(items.find((e) => e.id === "due")).toMatchObject({
			status: "open",
			reopenReason: "snooze-ended",
		});
		expect(items.find((e) => e.id === "due")?.snoozedUntil).toBeUndefined();
		expect(items.find((e) => e.id === "later")).toEqual(later);
		expect(report).toEqual({
			snoozesEnded: 1,
			orphaned: 0,
			claimsExpired: 0,
			pruned: 0,
			errors: [],
		});
		expect(calls(host, "notify").map((call) => call.args[0])).toEqual([
			expect.objectContaining({ kind: "escalation.reopened" }),
		]);
		expect(calls(host, "surfaces.changed").length).toBeGreaterThan(0);
	});

	it("orphans items of a deleted job, clears answers, and does not re-notify", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			// no jobs registered → nightly-check is deleted
		});
		const store = new EscalationStore(host);
		const answered = answer(item("answered"), { option: "retry", by: "alice" }, NOW);
		await seed(store, ALICE, [answered]);

		const first = await runSweep({ host, store, now: () => NOW });
		const stored = (await store.list(ALICE))[0];
		expect(stored).toMatchObject({
			status: "open",
			orphaned: true,
			reopenReason: "job-deleted",
		});
		expect(stored?.answer).toBeUndefined();
		expect(first).toMatchObject({ orphaned: 1, errors: [] });
		expect(calls(host, "notify").map((call) => call.args[0])).toEqual([
			expect.objectContaining({ kind: "escalation.orphaned" }),
		]);

		const second = await runSweep({ host, store, now: () => NOW });
		expect(second).toMatchObject({ orphaned: 0 });
		expect(calls(host, "notify")).toHaveLength(1);
	});

	it("looks up a job once per sweep for two items of the same job", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		await seed(store, ALICE, [
			item("first"),
			{ ...item("second"), key: "disk:/srv/b" },
		]);

		await runSweep({ host, store, now: () => NOW });
		expect(calls(host, "jobs.get")).toHaveLength(1);
		expect(calls(host, "jobs.get")[0]?.args).toEqual(["nightly-check"]);
	});

	it("prefetches jobs.get before entering the bucket update", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		await seed(store, ALICE, [item("one")]);

		const order: string[] = [];
		const originalGet = host.jobs.get.bind(host.jobs);
		host.jobs.get = async (id) => {
			order.push("jobs.get");
			return originalGet(id);
		};
		const originalUpdate = store.update.bind(store);
		store.update = async (bucket, fn) => {
			order.push("store.update");
			return originalUpdate(bucket, fn);
		};

		await runSweep({ host, store, now: () => NOW });
		expect(order.indexOf("jobs.get")).toBeLessThan(order.indexOf("store.update"));
	});

	it("releases a claim 24h+1ms old with note 'claim timed out' and leaves a 23h claim", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		const stale = claim(
			answer(item("stale"), { option: "retry" }, NOW),
			10,
			new Date(NOW.getTime() - 24 * 60 * 60 * 1000 - 1),
		);
		const fresh = claim(
			answer({ ...item("fresh"), key: "disk:/srv/b" }, { option: "retry" }, NOW),
			11,
			new Date(NOW.getTime() - 23 * 60 * 60 * 1000),
		);
		await seed(store, ALICE, [stale, fresh]);

		const report = await runSweep({ host, store, now: () => NOW });

		const items = await store.list(ALICE);
		const released = items.find((e) => e.id === "stale");
		expect(released).toMatchObject({
			status: "open",
			reopenReason: "interrupted",
		});
		expect(released?.claim).toBeUndefined();
		expect(released?.answer).toBeUndefined();
		expect(released?.history.at(-1)).toMatchObject({
			event: "interrupted",
			note: "claim timed out",
		});
		expect(items.find((e) => e.id === "fresh")).toEqual(fresh);
		expect(report).toMatchObject({ claimsExpired: 1 });
	});

	it("prunes resolved items older than 90 days and keeps an 89-day one", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		const old = resolved("old", new Date(NOW.getTime() - 90 * DAY_MS - 1));
		const recent = resolved("recent", new Date(NOW.getTime() - 89 * DAY_MS));
		await seed(store, ALICE, [old, recent]);

		const report = await runSweep({ host, store, now: () => NOW });

		expect((await store.list(ALICE)).map((e) => e.id)).toEqual(["recent"]);
		expect(report).toMatchObject({ pruned: 1 });
	});

	it("reports a corrupt bucket in errors and still sweeps the other bucket", async () => {
		const host = await fakeHost({
			users: [
				{ user: "alice", admin: false },
				{ user: "bob", admin: false },
			],
			jobs: { "nightly-check": job() },
		});
		const store = new EscalationStore(host);
		const alicePath = store.fileOf(ALICE);
		await mkdir(dirname(alicePath), { recursive: true });
		await writeFile(alicePath, "{not json");
		const due = snoozed("bob-due", NOW);
		await seed(store, BOB, [due]);

		const report = await runSweep({ host, store, now: () => NOW });

		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain(alicePath);
		expect((await store.list(BOB))[0]).toMatchObject({
			status: "open",
			reopenReason: "snooze-ended",
		});
		expect(report.snoozesEnded).toBe(1);
	});

	it("does not touch claimed items whose job was deleted until their claim times out", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
			// no jobs registered
		});
		const store = new EscalationStore(host);
		const claimed = claim(
			answer(item("claimed"), { option: "retry" }, NOW),
			10,
			NOW,
		);
		await seed(store, ALICE, [claimed]);

		await runSweep({ host, store, now: () => NOW });

		const stored = (await store.list(ALICE))[0];
		expect(stored).toMatchObject({
			status: "claimed",
			orphaned: true,
			claim: { conversationId: 10 },
		});
		expect(stored?.answer).toBeDefined();
	});
});
