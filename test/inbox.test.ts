/**
 * Task E6 tests: the Inbox view (`src/inbox.ts`) — the four-tab list and
 * the per-item detail page, with its actions.
 *
 * The contract under test:
 *
 * - Visibility: list and detail read only the CALLING principal's
 *   visible buckets (`bucketsVisibleTo`); another user's id renders the
 *   SAME not-found body as an unknown id, and none of the hidden item's
 *   title leaks (Review Focus 5).
 * - Tree shape: every tree passes the server's own `validateTree`
 *   (placement `view`, handlers = the declared action keys) — list mode
 *   on each tab and detail mode for open, answered, dismissed and
 *   orphaned items. The answer form's options carry NO `recommended`
 *   flag (the controller ruling: no preselection of a potentially
 *   destructive proposed action).
 * - Actions: `answer` on an immediate item starts a run (answered →
 *   claimed by the created conversation); a `next-run` item stays
 *   answered; orphaned items reject; snooze days are bounded; bulk
 *   actions skip invalid ids; every successful action notifies the
 *   inbox surface instances.
 */

import { describe, expect, test } from "vitest";
import { validateTree } from "@sigrun/sigrun/blocks";
import type {
	ActionResult,
	Principal,
	SurfaceContext,
} from "@sigrun/sigrun/extension";
import type { ConversationId } from "@earendil-works/pi-durable";
import { writeFile } from "node:fs/promises";
import { createInboxView } from "../src/inbox.js";
import { answer, claim, dismiss, orphan, raise, snooze } from "../src/lifecycle.js";
import { EscalationStore } from "../src/store.js";
import type { Bucket, Escalation, EscalationOption } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const NOW = new Date("2026-11-02T12:00:00.000Z");
const ALICE: Bucket = { kind: "user", user: "alice" };
const SHARED: Bucket = { kind: "shared" };
const OPTIONS: EscalationOption[] = [
	{ id: "retry", label: "Retry the check", detail: "Run it again" },
	{ id: "ignore-path", label: "Ignore this path" },
];
const hosts: FakeHost[] = [];

const USERS: FakeHostOptions = {
	users: [
		{ user: "alice", admin: false },
		{ user: "bob", admin: false },
		{ user: "root-admin", admin: true },
	],
	jobs: {
		"nightly-check": {
			id: "nightly-check",
			name: "Nightly check",
			owner: "alice",
			enabled: true,
			state: { status: "idle" } as never,
		},
	},
};

function principal(user: string | undefined, admin = false): Principal {
	return { user, admin, service: false, method: "token" };
}

function ctxOf(
	user: string | undefined,
	params: Record<string, unknown> = {},
	admin = false,
): SurfaceContext {
	return {
		principal: principal(user, admin),
		params: params as SurfaceContext["params"],
		key: "test",
		signal: new AbortController().signal,
	};
}

interface SeedOverrides extends Partial<Escalation> {
	readonly key: string;
}

/** One raised item with test-owned literals, parked in a bucket. */
async function seed(
	store: EscalationStore,
	bucket: Bucket,
	opts: SeedOverrides,
): Promise<Escalation> {
	const { key, ...overrides } = opts;
	// Strip display-only overrides from the raise input: raise owns
	// createdAt/updatedAt/history, and the lifecycle transitions below own
	// status/answer/claim/snoozedUntil/resolvedAt — the fixture's status is
	// the STARTING point, not the end state.
	const {
		createdAt: _createdAt,
		updatedAt: _updatedAt,
		history: _history,
		resolvedAt,
		status: _status,
		answer: _answer,
		claim: _claim,
		snoozedUntil: _snoozedUntil,
		...raiseOverrides
	} = overrides;
	let item = raise(
		{
			owner: bucket.kind === "user" ? bucket.user : undefined,
			namespace: "job:nightly-check",
			key,
			title: `Decision for ${key}`,
			body: `Evidence and proposed action for ${key}.`,
			options: OPTIONS,
			allowInstruction: true,
			onAnswer: "next-run",
			source: { jobId: "nightly-check", conversationId: 1 },
			...raiseOverrides,
		},
		NOW,
	);
	// Only the display-time stamps ride the post-raise spread; status and
	// its derived fields belong to the lifecycle transitions below.
	item = {
		...item,
		...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
		...(overrides.updatedAt === undefined ? {} : { updatedAt: overrides.updatedAt }),
		...(overrides.history === undefined ? {} : { history: overrides.history }),
		...(overrides.reopenReason === undefined ? {} : { reopenReason: overrides.reopenReason }),
		...(resolvedAt === undefined ? {} : { resolvedAt }),
		// A resolved fixture has no open-path transition (resolve() needs a
		// claim), so its status is applied directly.
		...(_status === "resolved" ? { status: "resolved" as const } : {}),
	};
	const status = _status ?? "open";
	if (status === "answered" || status === "claimed") {
		item = answer(item, { option: "retry", by: item.owner }, NOW);
		if (status === "claimed") item = claim(item, 7, NOW);
	} else if (status === "dismissed") {
		item = dismiss(item, NOW);
	} else if (status === "snoozed") {
		item = snooze(item, 3, NOW);
	}
	if (opts.orphaned === true) item = orphan(item, NOW);
	await store.update(bucket, (items) => ({
		items: [...items, item],
		result: undefined,
	}));
	return item;
}

async function rig(opts: FakeHostOptions = USERS) {
	const host = await createFakeHost(opts);
	hosts.push(host);
	const store = new EscalationStore(host);
	const view = createInboxView({ host, store, now: () => NOW });
	return { host, store, view };
}

async function act(
	view: ReturnType<typeof createInboxView>,
	ctx: SurfaceContext,
	name: string,
	payload: Record<string, unknown>,
): Promise<ActionResult> {
	const handler = view.actions?.[name];
	expect(handler, `action ${name}`).toBeDefined();
	return await handler!(ctx, payload as never);
}

function checkTree(view: ReturnType<typeof createInboxView>, tree: unknown): void {
	const verdict = validateTree(tree, {
		placement: "view",
		handlers: new Set(Object.keys(view.actions ?? {})),
	});
	expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
}

/** Every `{ $: "/items" }` row the rendered data carries. */
function itemsOf(rendered: { data: Record<string, unknown> }): { id: string }[] {
	return rendered.data.items as { id: string }[];
}

describe("inbox list mode", () => {
	test("alice's list shows only her items; root-admin's includes shared items", async () => {
		const { store, view } = await rig();
		const mine = await seed(store, ALICE, { key: "disk:/srv/a" });
		const bobs = await seed(store, { kind: "user", user: "bob" }, { key: "disk:/srv/b" });
		const shared = await seed(store, SHARED, { key: "disk:/srv/shared" });

		const alices = await view.render(ctxOf("alice"));
		expect(alices.access).toBe("write");
		const aliceIds = itemsOf(alices).map((item) => item.id);
		expect(aliceIds).toEqual([mine.id]);
		expect(JSON.stringify(alices.tree)).not.toContain(bobs.title);
		checkTree(view, alices.tree);

		// The shared bucket is what the user-less service principal sees
		// (bucketsVisibleTo's E2 contract: no user → [shared]); root-admin
		// is an ordinary user bucket here.
		const serviceCtx: SurfaceContext = {
			principal: { user: undefined, admin: true, service: true, method: "token" },
			params: {},
			key: "test",
			signal: new AbortController().signal,
		};
		const service = await view.render(serviceCtx);
		const serviceIds = itemsOf(service).map((item) => item.id);
		expect(serviceIds).toContain(shared.id);
		expect(serviceIds).not.toContain(mine.id);

		const bobsView = await view.render(ctxOf("bob"));
		expect(itemsOf(bobsView).map((item) => item.id)).toEqual([bobs.id]);

		// An unknown principal has no visible bucket: access none.
		const stranger = await view.render(ctxOf("mallory"));
		expect(stranger.access).toBe("none");
	});

	test("open tab sorts reopened first, then newest; resolved newest first; tabs filter", async () => {
		const { store, view } = await rig();
		const older = await seed(store, ALICE, {
			key: "disk:/srv/old",
			createdAt: "2026-11-01T00:00:00.000Z",
			updatedAt: "2026-11-01T00:00:00.000Z",
			history: [{ at: "2026-11-01T00:00:00.000Z", event: "raised" }],
		});
		const newer = await seed(store, ALICE, {
			key: "disk:/srv/new",
			createdAt: "2026-11-02T00:00:00.000Z",
			updatedAt: "2026-11-02T00:00:00.000Z",
			history: [{ at: "2026-11-02T00:00:00.000Z", event: "raised" }],
		});
		const reopened = await seed(store, ALICE, {
			key: "disk:/srv/reopened",
			createdAt: "2026-10-30T00:00:00.000Z",
			updatedAt: "2026-11-01T12:00:00.000Z",
			reopenReason: "failed",
		});
		const answered = await seed(store, ALICE, { key: "disk:/srv/answered", status: "answered" });
		const claimed = await seed(store, ALICE, { key: "disk:/srv/claimed", status: "claimed" });
		const snoozed = await seed(store, ALICE, { key: "disk:/srv/snoozed", status: "snoozed" });
		const dismissed = await seed(store, ALICE, { key: "disk:/srv/dismissed", status: "dismissed" });
		const resolvedOld = await seed(store, ALICE, {
			key: "disk:/srv/resolved-old",
			status: "resolved",
			createdAt: "2026-11-01T00:00:00.000Z",
			resolvedAt: "2026-11-01T01:00:00.000Z",
			history: [{ at: "2026-11-01T00:00:00.000Z", event: "raised" }],
		});
		const resolvedNew = await seed(store, ALICE, {
			key: "disk:/srv/resolved-new",
			status: "resolved",
			createdAt: "2026-11-01T02:00:00.000Z",
			resolvedAt: "2026-11-02T01:00:00.000Z",
			history: [{ at: "2026-11-01T02:00:00.000Z", event: "raised" }],
		});

		const open = await view.render(ctxOf("alice"));
		expect(itemsOf(open).map((item) => item.id)).toEqual([
			reopened.id,
			newer.id,
			older.id,
		]);
		checkTree(view, open.tree);
		// The reopen reason surfaces as a badge.
		const openRows = itemsOf(open) as unknown as Record<string, unknown>[];
		expect(openRows[0]?.reopenReason).toBe("failed");

		const active = await view.render(ctxOf("alice", { tab: "active" }));
		expect(new Set(itemsOf(active).map((item) => item.id))).toEqual(
			new Set([answered.id, claimed.id, snoozed.id]),
		);
		checkTree(view, active.tree);

		const dismissedTab = await view.render(ctxOf("alice", { tab: "dismissed" }));
		expect(itemsOf(dismissedTab).map((item) => item.id)).toEqual([dismissed.id]);
		checkTree(view, dismissedTab.tree);

		const resolved = await view.render(ctxOf("alice", { tab: "resolved" }));
		expect(itemsOf(resolved).map((item) => item.id)).toEqual([
			resolvedNew.id,
			resolvedOld.id,
		]);
		checkTree(view, resolved.tree);
	});

	test("an answered next-run item whose job is disabled shows the waiting badge", async () => {
		const { host, store, view } = await rig();
		const waiting = await seed(store, ALICE, { key: "disk:/srv/waiting", status: "answered" });
		const job = (await host.jobs.get("nightly-check"))!;
		host.setJob("nightly-check", { ...job, enabled: false });
		const active = await view.render(ctxOf("alice", { tab: "active" }));
		const rows = itemsOf(active) as unknown as Record<string, unknown>[];
		expect(rows[0]?.id).toBe(waiting.id);
		expect(rows[0]?.waitingBadge).toBe("Waiting: job disabled");
		expect(JSON.stringify(active.tree)).toContain("./waitingBadge");
		checkTree(view, active.tree);
	});

	test("a corrupt store file renders a bad callout with the error instead of the collection", async () => {
		const { store, view } = await rig();
		await seed(store, ALICE, { key: "disk:/srv/a" });
		await writeFile(store.fileOf(ALICE), "{not json", "utf8");
		const rendered = await view.render(ctxOf("alice"));
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain('"callout"');
		expect(text).toContain('"bad"');
		expect(text).not.toContain('"collection"');
		expect(rendered.access).toBe("write");
		checkTree(view, rendered.tree);
		// The error message itself is surfaced.
		expect(text.length).toBeGreaterThan(0);
		expect(rendered.data.error).toBeTruthy();
	});

	test("list groups by source and labels jobs, conversations and agents", async () => {
		const { store, view } = await rig();
		const byJob = await seed(store, ALICE, { key: "disk:/srv/job" });
		const byConversation = await seed(store, ALICE, {
			key: "disk:/srv/conversation",
			source: { conversationId: 42 },
		});
		const byAgent = await seed(store, ALICE, {
			key: "disk:/srv/agent",
			source: {},
		});
		const orphaned = await seed(store, ALICE, { key: "disk:/srv/orphaned", orphaned: true });
		const rendered = await view.render(ctxOf("alice"));
		const rows = itemsOf(rendered) as unknown as Record<string, unknown>[];
		const sourceOf = (id: string): string => rows.find((row) => row.id === id)?.source as string;
		expect(sourceOf(byJob.id)).toBe("Job Nightly check");
		expect(sourceOf(byConversation.id)).toBe("Conversation #42");
		expect(sourceOf(byAgent.id)).toBe("Agent");
		expect(sourceOf(orphaned.id)).toBe("Job deleted");
		checkTree(view, rendered.tree);
	});
});

describe("inbox detail mode", () => {
	test("open item: answer form (no recommended option), snooze form, dismiss action, history; tree validates", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const rendered = await view.render(ctxOf("alice", { id: item.id }));
		expect(rendered.access).toBe("write");
		checkTree(view, rendered.tree);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain(item.title);
		expect(text).toContain("Evidence and proposed action");
		expect(text).toContain("Send answer");
		expect(text).toContain("Snooze");
		expect(text).toContain("Dismiss this escalation?");
		expect(text).toContain(
			"It will not come back unless you restore it. The job will skip this issue.",
		);
		expect(text).toContain('"log"');
		// The snooze seed: number fields have no default, so data carries it.
		expect(rendered.data.snooze).toEqual({ days: 7 });
		expect(rendered.data.answer).toEqual({});
		// Ruling: NO option is marked recommended (no preselection).
		const serialized = JSON.stringify(rendered.tree);
		expect(serialized).not.toContain('"recommended":true');
		// Options appear in the agent's order.
		const retryAt = serialized.indexOf("Retry the check");
		const ignoreAt = serialized.indexOf("Ignore this path");
		expect(retryAt).toBeGreaterThanOrEqual(0);
		expect(ignoreAt).toBeGreaterThan(retryAt);
		// Conversation links navigate to the source conversation.
		expect(serialized).toContain('"conversation":1');
	});

	test("answered item: withdraw action, no answer form; dismissed item: restore; both validate", async () => {
		const { store, view } = await rig();
		const answered = await seed(store, ALICE, { key: "disk:/srv/answered", status: "answered" });
		const answeredView = await view.render(ctxOf("alice", { id: answered.id }));
		checkTree(view, answeredView.tree);
		const answeredText = JSON.stringify(answeredView.tree);
		expect(answeredText).toContain("Withdraw answer");
		expect(answeredText).not.toContain("Send answer");

		const dismissed = await seed(store, ALICE, { key: "disk:/srv/dismissed", status: "dismissed" });
		const dismissedView = await view.render(ctxOf("alice", { id: dismissed.id }));
		checkTree(view, dismissedView.tree);
		const dismissedText = JSON.stringify(dismissedView.tree);
		expect(dismissedText).toContain("Restore");
		expect(dismissedText).not.toContain("Send answer");
		expect(dismissedText).not.toContain("Withdraw answer");
	});

	test("claimed item: the claim conversation link renders", async () => {
		const { store, view } = await rig();
		const claimed = await seed(store, ALICE, { key: "disk:/srv/claimed", status: "claimed" });
		const rendered = await view.render(ctxOf("alice", { id: claimed.id }));
		checkTree(view, rendered.tree);
		expect(JSON.stringify(rendered.tree)).toContain('"conversation":7');
	});

	test("orphaned item: warn callout with the pinned text, only Dismiss; validates", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/orphaned", orphaned: true });
		const rendered = await view.render(ctxOf("alice", { id: item.id }));
		checkTree(view, rendered.tree);
		const text = JSON.stringify(rendered.tree);
		expect(text).toContain(
			"This escalation's job was deleted. Nothing can act on it; dismiss it when you've read it.",
		);
		expect(text).toContain('"warn"');
		expect(text).not.toContain("Send answer");
		expect(text).not.toContain("Snooze");
		expect(text).not.toContain("Withdraw answer");
		expect(text).toContain("Dismiss this escalation?");
	});

	test("Review Focus 5: bob rendering alice's id gets the same not-found body as an unknown id, with no title leak", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/secret" });
		const other = await view.render(ctxOf("bob", { id: item.id }));
		const unknown = await view.render(ctxOf("bob", { id: "nope" }));
		expect(JSON.stringify(other)).toEqual(JSON.stringify(unknown));
		expect(JSON.stringify(other.tree)).not.toContain("disk:/srv/secret");
		expect(JSON.stringify(other.tree)).not.toContain(item.title);
		checkTree(view, other.tree);
		// The actions reject identically too.
		const actOther = await act(view, ctxOf("bob"), "dismiss", { itemId: item.id });
		const actUnknown = await act(view, ctxOf("bob"), "dismiss", { itemId: "nope" });
		expect(actOther).toEqual({ ok: false, error: { message: "Escalation not found" } });
		expect(actUnknown).toEqual(actOther);
	});
});

describe("inbox actions", () => {
	test("open({itemId}) navigates to the detail instance", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const result = await act(view, ctxOf("alice"), "open", { itemId: item.id });
		expect(result).toEqual({
			ok: true,
			navigate: { type: "navigate", params: { id: item.id } },
		});
	});

	test("answer on an immediate item: answered then claimed by the created conversation; toast names the run", async () => {
		const { host, store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a", onAnswer: "immediate" });
		const result = await act(view, ctxOf("alice"), "answer", {
			itemId: item.id,
			values: { option: "retry", instruction: "check the mount first" },
		});
		expect(result).toMatchObject({ ok: true, toast: "Answer sent — started a run" });
		const stored = (await store.list(ALICE)).find((row) => row.id === item.id)!;
		expect(stored.status).toBe("claimed");
		expect(stored.answer?.option).toBe("retry");
		expect(stored.answer?.instruction).toBe("check the mount first");
		expect(stored.answer?.by).toBe("alice");
		expect(stored.claim?.conversationId).toBe(1);
		// The immediate run was seeded with the decision.
		const submit = host.calls.find((call) => call.method === "conversations.submit");
		expect(submit).toBeDefined();
		// Every inbox instance for this record was notified.
		const changed = host.calls.filter((call) => call.method === "surfaces.changed");
		expect(changed.some((call) => call.args[1] === `{"id":${JSON.stringify(item.id)}}`)).toBe(true);
		// Detail actions navigate back to the item.
		expect(result).toMatchObject({
			navigate: { type: "navigate", params: { id: item.id } },
		});
	});

	test("answer on a next-run item stays answered with the plain toast", async () => {
		const { host, store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const result = await act(view, ctxOf("alice"), "answer", {
			itemId: item.id,
			values: { option: "retry" },
		});
		expect(result).toMatchObject({ ok: true, toast: "Answer sent" });
		const stored = (await store.list(ALICE)).find((row) => row.id === item.id)!;
		expect(stored.status).toBe("answered");
		expect(host.calls.some((call) => call.method === "conversations.create")).toBe(false);
	});

	test("answer on an orphaned item rejects", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a", orphaned: true });
		const result = await act(view, ctxOf("alice"), "answer", {
			itemId: item.id,
			values: { option: "retry" },
		});
		expect(result.ok).toBe(false);
		const stored = (await store.list(ALICE)).find((row) => row.id === item.id)!;
		expect(stored.status).toBe("open");
	});

	test("snooze days 0 rejects with a 1-and-365 message; valid snooze and withdraw/restore work", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const bad = await act(view, ctxOf("alice"), "snooze", {
			itemId: item.id,
			values: { days: 0 },
		});
		expect(bad.ok).toBe(false);
		expect(JSON.stringify(bad)).toContain("1 and 365");

		const good = await act(view, ctxOf("alice"), "snooze", {
			itemId: item.id,
			values: { days: 7 },
		});
		expect(good).toMatchObject({ ok: true });
		expect((await store.list(ALICE))[0]?.status).toBe("snoozed");

		// Withdraw an answer.
		const answered = await seed(store, ALICE, { key: "disk:/srv/b", status: "answered" });
		const withdrew = await act(view, ctxOf("alice"), "withdraw", { itemId: answered.id });
		expect(withdrew).toMatchObject({ ok: true });
		expect((await store.list(ALICE)).find((row) => row.id === answered.id)?.status).toBe("open");

		// Restore a dismissed item.
		const dismissed = await seed(store, ALICE, { key: "disk:/srv/c", status: "dismissed" });
		const restored = await act(view, ctxOf("alice"), "restore", { itemId: dismissed.id });
		expect(restored).toMatchObject({ ok: true });
		expect((await store.list(ALICE)).find((row) => row.id === dismissed.id)?.status).toBe("open");
	});

	test("dismiss navigates back to the open tab", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const result = await act(view, ctxOf("alice"), "dismiss", { itemId: item.id });
		expect(result).toMatchObject({
			ok: true,
			navigate: { type: "navigate", params: { tab: "open" } },
		});
		expect((await store.list(ALICE))[0]?.status).toBe("dismissed");
	});

	test("dismiss-many with one valid and one unknown id dismisses one; restore-many likewise", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a" });
		const result = await act(view, ctxOf("alice"), "dismiss-many", {
			ids: [item.id, "nope"],
			values: { ignored: true },
		});
		expect(result).toMatchObject({ ok: true });
		const rows = await store.list(ALICE);
		expect(rows.find((row) => row.id === item.id)?.status).toBe("dismissed");
		expect(rows).toHaveLength(1);

		const restored = await act(view, ctxOf("alice"), "restore-many", {
			ids: [item.id, "nope"],
		});
		expect(restored).toMatchObject({ ok: true });
		expect((await store.list(ALICE))[0]?.status).toBe("open");
	});

	test("a second dismiss rejects with a readable TransitionError message", async () => {
		const { store, view } = await rig();
		const item = await seed(store, ALICE, { key: "disk:/srv/a", status: "dismissed" });
		const result = await act(view, ctxOf("alice"), "dismiss", { itemId: item.id });
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("not_dismissable");
	});
});
