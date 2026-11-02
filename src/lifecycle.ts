import { randomUUID } from "node:crypto";
import {
	SKIP_STATUSES,
	type Escalation,
	type EscalationAnswer,
	type HistoryEntry,
	type RaiseInput,
} from "./types.js";

/** A disallowed lifecycle transition, identified by a stable machine code. */
export class TransitionError extends Error {
	readonly code: string;

	constructor(code: string) {
		super(code);
		this.name = "TransitionError";
		this.code = code;
	}
}

function changed(
	e: Escalation,
	now: Date,
	entry: Omit<HistoryEntry, "at">,
	updates: Partial<Escalation>,
): Escalation {
	return {
		...e,
		...updates,
		updatedAt: now.toISOString(),
		history: [...e.history, { at: now.toISOString(), ...entry }],
	};
}

export function raise(input: RaiseInput, now: Date): Escalation {
	const at = now.toISOString();
	return {
		...input,
		id: randomUUID(),
		status: "open",
		createdAt: at,
		updatedAt: at,
		history: [{ at, event: "raised" }],
	};
}

export function answer(
	e: Escalation,
	a: { option?: string; instruction?: string; by?: string },
	now: Date,
): Escalation {
	if (e.status !== "open") throw new TransitionError("not_open");
	if (e.orphaned) throw new TransitionError("orphaned");
	if (a.option === undefined && a.instruction === undefined) {
		throw new TransitionError("empty_answer");
	}
	if (a.option !== undefined && !e.options.some((option) => option.id === a.option)) {
		throw new TransitionError("unknown_option");
	}
	if (a.instruction !== undefined && !e.allowInstruction) {
		throw new TransitionError("instruction_not_allowed");
	}

	const nextAnswer: EscalationAnswer = {
		...(a.option === undefined ? {} : { option: a.option }),
		...(a.instruction === undefined ? {} : { instruction: a.instruction }),
		...(a.by === undefined ? {} : { by: a.by }),
		at: now.toISOString(),
	};
	return changed(
		e,
		now,
		{ event: "answered", answer: nextAnswer },
		{ status: "answered", answer: nextAnswer },
	);
}

export function withdraw(e: Escalation, now: Date): Escalation {
	if (e.status !== "answered") throw new TransitionError("not_answered");
	return changed(
		e,
		now,
		{ event: "withdrawn", ...(e.answer === undefined ? {} : { answer: e.answer }) },
		{ status: "open", answer: undefined },
	);
}

export function claim(e: Escalation, conversationId: number, now: Date): Escalation {
	if (e.status === "claimed" && e.claim?.conversationId === conversationId) {
		return e;
	}
	if (e.status !== "answered") throw new TransitionError("not_claimable");
	return changed(
		e,
		now,
		{ event: "claimed" },
		{ status: "claimed", claim: { conversationId, at: now.toISOString() } },
	);
}

export function resolve(
	e: Escalation,
	conversationId: number,
	outcome: "done" | "failed",
	note: string,
	now: Date,
): Escalation {
	if (e.status !== "claimed" || e.claim === undefined) {
		throw new TransitionError("not_claimed");
	}
	if (e.claim.conversationId !== conversationId) {
		throw new TransitionError("wrong_claimant");
	}
	if (outcome === "done") {
		return changed(
			e,
			now,
			{ event: "resolved", note },
			{ status: "resolved", resolvedAt: now.toISOString() },
		);
	}
	return changed(
		e,
		now,
		{
			event: "failed",
			note,
			...(e.answer === undefined ? {} : { answer: e.answer }),
		},
		{
			status: "open",
			answer: undefined,
			claim: undefined,
			reopenReason: "failed",
		},
	);
}

export function release(
	e: Escalation,
	conversationId: number,
	note: string,
	now: Date,
): Escalation {
	if (e.status !== "claimed" || e.claim?.conversationId !== conversationId) {
		throw new TransitionError("not_claimed");
	}
	return changed(
		e,
		now,
		{
			event: "interrupted",
			note,
			...(e.answer === undefined ? {} : { answer: e.answer }),
		},
		{
			status: "open",
			answer: undefined,
			claim: undefined,
			reopenReason: "interrupted",
		},
	);
}

export function dismiss(e: Escalation, now: Date): Escalation {
	if (e.status !== "open" && e.status !== "answered") {
		throw new TransitionError("not_dismissable");
	}
	return changed(e, now, { event: "dismissed" }, { status: "dismissed", answer: undefined });
}

export function restore(e: Escalation, now: Date): Escalation {
	if (e.status !== "dismissed") throw new TransitionError("not_dismissed");
	return changed(e, now, { event: "restored" }, { status: "open" });
}

export function snooze(e: Escalation, days: number, now: Date): Escalation {
	if (!Number.isInteger(days) || days < 1 || days > 365) {
		throw new TransitionError("bad_days");
	}
	if (e.status !== "open" && e.status !== "answered") {
		throw new TransitionError("not_snoozable");
	}
	if (e.orphaned) throw new TransitionError("orphaned");
	return changed(
		e,
		now,
		{ event: "snoozed" },
		{
			status: "snoozed",
			answer: undefined,
			snoozedUntil: new Date(now.getTime() + days * 86_400_000).toISOString(),
		},
	);
}

export function endSnooze(e: Escalation, now: Date): Escalation {
	if (
		e.status !== "snoozed" ||
		e.snoozedUntil === undefined ||
		e.snoozedUntil > now.toISOString()
	) {
		return e;
	}
	return changed(
		e,
		now,
		{ event: "snooze-ended" },
		{ status: "open", snoozedUntil: undefined, reopenReason: "snooze-ended" },
	);
}

export function orphan(e: Escalation, now: Date): Escalation {
	if (e.status === "resolved" || e.status === "dismissed" || e.orphaned) {
		return e;
	}
	return changed(
		e,
		now,
		{ event: "job-deleted", note: "job deleted" },
		{
			status: e.status === "answered" ? "open" : e.status,
			answer: e.status === "answered" ? undefined : e.answer,
			orphaned: true,
			reopenReason: "job-deleted",
		},
	);
}

export function isSkip(e: Escalation): boolean {
	return SKIP_STATUSES.includes(e.status);
}
