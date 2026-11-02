import { type Escalation, type RaiseInput } from "./types.js";
/** A disallowed lifecycle transition, identified by a stable machine code. */
export declare class TransitionError extends Error {
    readonly code: string;
    constructor(code: string);
}
export declare function raise(input: RaiseInput, now: Date): Escalation;
export declare function answer(e: Escalation, a: {
    option?: string;
    instruction?: string;
    by?: string;
}, now: Date): Escalation;
export declare function withdraw(e: Escalation, now: Date): Escalation;
export declare function claim(e: Escalation, conversationId: number, now: Date): Escalation;
export declare function resolve(e: Escalation, conversationId: number, outcome: "done" | "failed", note: string, now: Date): Escalation;
/** Reopen an unclaimed answer when its immediate action could not start. */
export declare function reopen(e: Escalation, note: string, now: Date): Escalation;
export declare function release(e: Escalation, conversationId: number, note: string, now: Date): Escalation;
export declare function dismiss(e: Escalation, now: Date): Escalation;
export declare function restore(e: Escalation, now: Date): Escalation;
export declare function snooze(e: Escalation, days: number, now: Date): Escalation;
export declare function endSnooze(e: Escalation, now: Date): Escalation;
export declare function orphan(e: Escalation, now: Date): Escalation;
export declare function isSkip(e: Escalation): boolean;
