import { describe, expect, it } from "vitest";
import {
	TransitionError,
	answer,
	claim,
	dismiss,
	endSnooze,
	isSkip,
	orphan,
	raise,
	release,
	reopen,
	resolve,
	restore,
	snooze,
	withdraw,
} from "../src/lifecycle.js";
import {
	SKIP_STATUSES,
	type Escalation,
	type RaiseInput,
} from "../src/types.js";

const RAISED_AT = new Date("2026-11-02T12:00:00.000Z");
const ANSWERED_AT = new Date("2026-11-02T12:01:00.000Z");
const CLAIMED_AT = new Date("2026-11-02T12:02:00.000Z");
const SETTLED_AT = new Date("2026-11-02T12:03:00.000Z");

function input(overrides: Partial<RaiseInput> = {}): RaiseInput {
	return {
		owner: "alice",
		namespace: "job:api:nightly-check",
		key: "disk:/srv/a",
		title: "Disk needs attention",
		body: "The nightly check found that the disk is nearly full.",
		options: [
			{ id: "retry", label: "Retry the check" },
			{ id: "stop", label: "Stop the job", detail: "Disable future runs" },
		],
		allowInstruction: true,
		onAnswer: "next-run",
		source: { jobId: "api:nightly-check", conversationId: 10 },
		...overrides,
	};
}

function opened(): Escalation {
	return raise(input(), RAISED_AT);
}

function answered(): Escalation {
	return answer(opened(), { option: "retry", by: "alice" }, ANSWERED_AT);
}

function claimed(): Escalation {
	return claim(answered(), 10, CLAIMED_AT);
}

function expectTransition(
	before: Escalation,
	after: Escalation,
	event: Escalation["history"][number]["event"],
	at: Date,
): void {
	const snapshot = structuredClone(before);
	expect(after).not.toBe(before);
	expect(after.updatedAt).toBe(at.toISOString());
	expect(after.history).toHaveLength(before.history.length + 1);
	expect(after.history.at(-1)).toMatchObject({
		at: at.toISOString(),
		event,
	});
	expect(before).toEqual(snapshot);
}

function expectCode(fn: () => unknown, code: string): void {
	let thrown: unknown;
	try {
		fn();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(TransitionError);
	expect(thrown).toMatchObject({ code });
}

describe("raise", () => {
	it("creates an open escalation with its initial history entry", () => {
		const e = raise(input(), RAISED_AT);

		expect(e.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(e).toMatchObject({
			...input(),
			status: "open",
			createdAt: RAISED_AT.toISOString(),
			updatedAt: RAISED_AT.toISOString(),
		});
		expect(e.history).toEqual([
			{ at: RAISED_AT.toISOString(), event: "raised" },
		]);
	});

	it("supports the shared ownerless bucket", () => {
		const { owner: _owner, ...withoutOwner } = input();
		expect(raise(withoutOwner, RAISED_AT).owner).toBeUndefined();
	});
});

describe("answer", () => {
	it("answers an open item with an option", () => {
		const before = opened();
		const after = answer(
			before,
			{ option: "retry", by: "alice" },
			ANSWERED_AT,
		);

		expectTransition(before, after, "answered", ANSWERED_AT);
		expect(after.status).toBe("answered");
		expect(after.answer).toEqual({
			option: "retry",
			by: "alice",
			at: ANSWERED_AT.toISOString(),
		});
		expect(after.history.at(-1)?.answer).toEqual(after.answer);
	});

	it("answers with an instruction when instructions are allowed", () => {
		const after = answer(
			opened(),
			{ instruction: "Check the other disk first" },
			ANSWERED_AT,
		);

		expect(after.answer).toEqual({
			instruction: "Check the other disk first",
			at: ANSWERED_AT.toISOString(),
		});
	});

	it("rejects an item that is not open", () => {
		expectCode(
			() => answer(answered(), { option: "retry" }, SETTLED_AT),
			"not_open",
		);
	});

	it("rejects an orphaned item", () => {
		expectCode(
			() => answer(orphan(opened(), SETTLED_AT), { option: "retry" }, SETTLED_AT),
			"orphaned",
		);
	});

	it("rejects an empty answer", () => {
		expectCode(() => answer(opened(), {}, ANSWERED_AT), "empty_answer");
	});

	it("rejects an unknown option", () => {
		expectCode(
			() => answer(opened(), { option: "zzz" }, ANSWERED_AT),
			"unknown_option",
		);
	});

	it("rejects an instruction when instructions are not allowed", () => {
		const e = raise(input({ allowInstruction: false }), RAISED_AT);
		expectCode(
			() => answer(e, { instruction: "Do something else" }, ANSWERED_AT),
			"instruction_not_allowed",
		);
	});
});

describe("withdraw", () => {
	it("reopens an answered item and clears its answer", () => {
		const before = answered();
		const after = withdraw(before, SETTLED_AT);

		expectTransition(before, after, "withdrawn", SETTLED_AT);
		expect(after.status).toBe("open");
		expect(after.answer).toBeUndefined();
	});

	it("rejects an item that is not answered", () => {
		expectCode(() => withdraw(opened(), SETTLED_AT), "not_answered");
	});
});

describe("claim", () => {
	it("claims an answered item for a conversation", () => {
		const before = answered();
		const after = claim(before, 10, CLAIMED_AT);

		expectTransition(before, after, "claimed", CLAIMED_AT);
		expect(after.status).toBe("claimed");
		expect(after.claim).toEqual({
			conversationId: 10,
			at: CLAIMED_AT.toISOString(),
		});
	});

	it("is idempotent for the same claimant", () => {
		const before = claimed();
		const history = before.history;
		expect(claim(before, 10, SETTLED_AT)).toBe(before);
		expect(before.history).toBe(history);
	});

	it("rejects another claimant", () => {
		expectCode(() => claim(claimed(), 11, SETTLED_AT), "not_claimable");
	});

	it("rejects an item that is not answered", () => {
		expectCode(() => claim(opened(), 10, SETTLED_AT), "not_claimable");
	});
});

describe("resolve", () => {
	it("resolves a successful claim", () => {
		const before = claimed();
		const after = resolve(before, 10, "done", "The check passed", SETTLED_AT);

		expectTransition(before, after, "resolved", SETTLED_AT);
		expect(after.status).toBe("resolved");
		expect(after.resolvedAt).toBe(SETTLED_AT.toISOString());
		expect(after.history.at(-1)?.note).toBe("The check passed");
	});

	it("reopens a failed claim, clearing the answer but retaining it in history", () => {
		const before = claimed();
		const previousAnswer = before.answer;
		const after = resolve(before, 10, "failed", "The retry failed", SETTLED_AT);

		expectTransition(before, after, "failed", SETTLED_AT);
		expect(after.status).toBe("open");
		expect(after.reopenReason).toBe("failed");
		expect(after.answer).toBeUndefined();
		expect(after.history.at(-1)).toMatchObject({
			note: "The retry failed",
			answer: previousAnswer,
		});
	});

	it("rejects an item that is not claimed", () => {
		expectCode(
			() => resolve(answered(), 10, "done", "Done", SETTLED_AT),
			"not_claimed",
		);
	});

	it("rejects the wrong claimant", () => {
		expectCode(
			() => resolve(claimed(), 11, "done", "Done", SETTLED_AT),
			"wrong_claimant",
		);
	});
});

describe("release", () => {
	it("reopens an interrupted claim, clearing the answer but retaining it in history", () => {
		const before = claimed();
		const previousAnswer = before.answer;
		const after = release(before, 10, "The run stopped", SETTLED_AT);

		expectTransition(before, after, "interrupted", SETTLED_AT);
		expect(after.status).toBe("open");
		expect(after.reopenReason).toBe("interrupted");
		expect(after.answer).toBeUndefined();
		expect(after.history.at(-1)).toMatchObject({
			note: "The run stopped",
			answer: previousAnswer,
		});
	});

	it("rejects an item that is not claimed", () => {
		expectCode(
			() => release(opened(), 10, "Not claimed", SETTLED_AT),
			"not_claimed",
		);
	});

	it("rejects a different conversation", () => {
		expectCode(
			() => release(claimed(), 11, "Wrong conversation", SETTLED_AT),
			"not_claimed",
		);
	});
});

describe("reopen", () => {
	it("reopens an answered item, retaining its answer in interruption history", () => {
		const before = answered();
		const previousAnswer = before.answer;
		const after = reopen(before, "dispatch failed: create refused", SETTLED_AT);

		expectTransition(before, after, "interrupted", SETTLED_AT);
		expect(after.status).toBe("open");
		expect(after.reopenReason).toBe("interrupted");
		expect(after.answer).toBeUndefined();
		expect(after.history.at(-1)).toMatchObject({
			note: "dispatch failed: create refused",
			answer: previousAnswer,
		});
	});

	it("rejects open, claimed, and dismissed items", () => {
		for (const before of [opened(), claimed(), dismiss(opened(), SETTLED_AT)]) {
			expectCode(() => reopen(before, "Not reopenable", SETTLED_AT), "not_reopenable");
		}
	});
});

describe("dismiss and restore", () => {
	it("dismisses an open item", () => {
		const before = opened();
		const after = dismiss(before, SETTLED_AT);

		expectTransition(before, after, "dismissed", SETTLED_AT);
		expect(after.status).toBe("dismissed");
	});

	it("dismisses an answered item and clears its answer", () => {
		expect(dismiss(answered(), SETTLED_AT).answer).toBeUndefined();
	});

	it("allows an orphaned item to be dismissed", () => {
		expect(dismiss(orphan(opened(), SETTLED_AT), SETTLED_AT).status).toBe(
			"dismissed",
		);
	});

	it("rejects dismissal from another status", () => {
		expectCode(() => dismiss(claimed(), SETTLED_AT), "not_dismissable");
	});

	it("restores a dismissed item", () => {
		const before = dismiss(opened(), SETTLED_AT);
		const at = new Date("2026-11-02T12:04:00.000Z");
		const after = restore(before, at);

		expectTransition(before, after, "restored", at);
		expect(after.status).toBe("open");
	});

	it("rejects restoring an item that is not dismissed", () => {
		expectCode(() => restore(opened(), SETTLED_AT), "not_dismissed");
	});
});

describe("snooze", () => {
	it("snoozes an open item for the requested whole days", () => {
		const before = opened();
		const after = snooze(before, 7, SETTLED_AT);

		expectTransition(before, after, "snoozed", SETTLED_AT);
		expect(after.status).toBe("snoozed");
		expect(after.snoozedUntil).toBe(
			new Date(SETTLED_AT.getTime() + 7 * 86_400_000).toISOString(),
		);
	});

	it("clears an existing answer when snoozing", () => {
		expect(snooze(answered(), 1, SETTLED_AT).answer).toBeUndefined();
	});

	it.each([0, 366, 1.5])("rejects invalid day count %s", (days) => {
		expectCode(() => snooze(opened(), days, SETTLED_AT), "bad_days");
	});

	it("rejects an item that cannot be snoozed", () => {
		expectCode(() => snooze(claimed(), 1, SETTLED_AT), "not_snoozable");
	});

	it("rejects an orphaned item", () => {
		expectCode(
			() => snooze(orphan(opened(), SETTLED_AT), 1, SETTLED_AT),
			"orphaned",
		);
	});
});

describe("endSnooze", () => {
	it("is a no-op one millisecond before the snooze ends", () => {
		const before = snooze(opened(), 1, SETTLED_AT);
		const until = new Date(before.snoozedUntil!);
		const history = before.history;

		expect(endSnooze(before, new Date(until.getTime() - 1))).toBe(before);
		expect(before.history).toBe(history);
	});

	it("reopens exactly when the snooze ends", () => {
		const before = snooze(opened(), 1, SETTLED_AT);
		const until = new Date(before.snoozedUntil!);
		const after = endSnooze(before, until);

		expectTransition(before, after, "snooze-ended", until);
		expect(after.status).toBe("open");
		expect(after.reopenReason).toBe("snooze-ended");
		expect(after.snoozedUntil).toBeUndefined();
	});

	it("is a no-op for an item that is not snoozed", () => {
		const before = opened();
		expect(endSnooze(before, SETTLED_AT)).toBe(before);
	});
});

describe("orphan", () => {
	it("marks an open item orphaned and records the deletion note", () => {
		const before = opened();
		const after = orphan(before, SETTLED_AT);

		expectTransition(before, after, "job-deleted", SETTLED_AT);
		expect(after).toMatchObject({
			status: "open",
			orphaned: true,
			reopenReason: "job-deleted",
		});
		expect(after.history.at(-1)?.note).toBe("job deleted");
	});

	it("reopens an answered item and clears its answer", () => {
		const after = orphan(answered(), SETTLED_AT);
		expect(after.status).toBe("open");
		expect(after.answer).toBeUndefined();
		expect(after.orphaned).toBe(true);
	});

	it("keeps a claimed item claimed", () => {
		const after = orphan(claimed(), SETTLED_AT);
		expect(after.status).toBe("claimed");
		expect(after.claim).toEqual(claimed().claim);
		expect(after.orphaned).toBe(true);
	});

	it("leaves resolved, dismissed, and already orphaned items unchanged", () => {
		const resolved = resolve(claimed(), 10, "done", "Done", SETTLED_AT);
		const dismissed = dismiss(opened(), SETTLED_AT);
		const orphaned = orphan(opened(), SETTLED_AT);

		for (const before of [resolved, dismissed, orphaned]) {
			const history = before.history;
			expect(orphan(before, SETTLED_AT)).toBe(before);
			expect(before.history).toBe(history);
		}
	});
});

describe("isSkip", () => {
	it("returns true for every skip status and false for resolved", () => {
		for (const status of SKIP_STATUSES) {
			expect(isSkip({ ...opened(), status })).toBe(true);
		}
		expect(isSkip({ ...opened(), status: "resolved" })).toBe(false);
	});
});
