import { randomUUID } from "node:crypto";
import { SKIP_STATUSES, } from "./types.js";
/** A disallowed lifecycle transition, identified by a stable machine code. */
export class TransitionError extends Error {
    code;
    constructor(code) {
        super(code);
        this.name = "TransitionError";
        this.code = code;
    }
}
function changed(e, now, entry, updates) {
    return {
        ...e,
        ...updates,
        updatedAt: now.toISOString(),
        history: [...e.history, { at: now.toISOString(), ...entry }],
    };
}
export function raise(input, now) {
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
export function answer(e, a, now) {
    if (e.status !== "open")
        throw new TransitionError("not_open");
    if (e.orphaned)
        throw new TransitionError("orphaned");
    if (a.option === undefined && a.instruction === undefined) {
        throw new TransitionError("empty_answer");
    }
    if (a.option !== undefined && !e.options.some((option) => option.id === a.option)) {
        throw new TransitionError("unknown_option");
    }
    if (a.instruction !== undefined && !e.allowInstruction) {
        throw new TransitionError("instruction_not_allowed");
    }
    const nextAnswer = {
        ...(a.option === undefined ? {} : { option: a.option }),
        ...(a.instruction === undefined ? {} : { instruction: a.instruction }),
        ...(a.by === undefined ? {} : { by: a.by }),
        at: now.toISOString(),
    };
    return changed(e, now, { event: "answered", answer: nextAnswer }, { status: "answered", answer: nextAnswer });
}
export function withdraw(e, now) {
    if (e.status !== "answered")
        throw new TransitionError("not_answered");
    return changed(e, now, { event: "withdrawn", ...(e.answer === undefined ? {} : { answer: e.answer }) }, { status: "open", answer: undefined });
}
export function claim(e, conversationId, now) {
    if (e.status === "claimed" && e.claim?.conversationId === conversationId) {
        return e;
    }
    if (e.status !== "answered")
        throw new TransitionError("not_claimable");
    return changed(e, now, { event: "claimed" }, { status: "claimed", claim: { conversationId, at: now.toISOString() } });
}
export function resolve(e, conversationId, outcome, note, now) {
    if (e.status !== "claimed" || e.claim === undefined) {
        throw new TransitionError("not_claimed");
    }
    if (e.claim.conversationId !== conversationId) {
        throw new TransitionError("wrong_claimant");
    }
    if (outcome === "done") {
        // Forward transition: the stale reopen badge must not survive onto
        // the terminal resolved state (inbox.ts renders it as a warn badge).
        return changed(e, now, { event: "resolved", note }, { status: "resolved", resolvedAt: now.toISOString(), reopenReason: undefined });
    }
    return changed(e, now, {
        event: "failed",
        note,
        ...(e.answer === undefined ? {} : { answer: e.answer }),
    }, {
        status: "open",
        answer: undefined,
        claim: undefined,
        reopenReason: "failed",
    });
}
/** Reopen an unclaimed answer when its immediate action could not start. */
export function reopen(e, note, now) {
    if (e.status !== "answered")
        throw new TransitionError("not_reopenable");
    return changed(e, now, {
        event: "interrupted",
        note,
        ...(e.answer === undefined ? {} : { answer: e.answer }),
    }, { status: "open", answer: undefined, reopenReason: "interrupted" });
}
export function release(e, conversationId, note, now) {
    if (e.status !== "claimed" || e.claim?.conversationId !== conversationId) {
        throw new TransitionError("not_claimed");
    }
    return changed(e, now, {
        event: "interrupted",
        note,
        ...(e.answer === undefined ? {} : { answer: e.answer }),
    }, {
        status: "open",
        answer: undefined,
        claim: undefined,
        reopenReason: "interrupted",
    });
}
export function dismiss(e, now) {
    if (e.status !== "open" && e.status !== "answered") {
        throw new TransitionError("not_dismissable");
    }
    return changed(e, now, { event: "dismissed" }, { status: "dismissed", answer: undefined, reopenReason: undefined });
}
export function restore(e, now) {
    if (e.status !== "dismissed")
        throw new TransitionError("not_dismissed");
    return changed(e, now, { event: "restored" }, { status: "open", reopenReason: undefined });
}
export function snooze(e, days, now) {
    if (!Number.isInteger(days) || days < 1 || days > 365) {
        throw new TransitionError("bad_days");
    }
    if (e.status !== "open" && e.status !== "answered") {
        throw new TransitionError("not_snoozable");
    }
    if (e.orphaned)
        throw new TransitionError("orphaned");
    return changed(e, now, { event: "snoozed" }, {
        status: "snoozed",
        answer: undefined,
        snoozedUntil: new Date(now.getTime() + days * 86_400_000).toISOString(),
    });
}
export function endSnooze(e, now) {
    if (e.status !== "snoozed" ||
        e.snoozedUntil === undefined ||
        e.snoozedUntil > now.toISOString()) {
        return e;
    }
    return changed(e, now, { event: "snooze-ended" }, { status: "open", snoozedUntil: undefined, reopenReason: "snooze-ended" });
}
export function orphan(e, now) {
    if (e.status === "resolved" || e.status === "dismissed" || e.orphaned) {
        return e;
    }
    return changed(e, now, { event: "job-deleted", note: "job deleted" }, {
        status: e.status === "answered" ? "open" : e.status,
        answer: e.status === "answered" ? undefined : e.answer,
        orphaned: true,
        reopenReason: "job-deleted",
    });
}
export function isSkip(e) {
    return SKIP_STATUSES.includes(e.status);
}
