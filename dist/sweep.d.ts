/**
 * The escalation sweep task (`escalations.sweep`), fired by the `sweep`
 * cron job every 15 minutes. Pure host calls + store updates: no model,
 * no transcript content.
 *
 * Job transfers first copy their items to the current owner's bucket,
 * then remove them from the source. Each remaining source bucket gets ONE
 * lifecycle update: end due snoozes, orphan items whose job was deleted,
 * release claims older than 24h, and prune resolved items older than 90
 * days. Job lookups are PREFETCHED before entering updates so no bucket
 * queue is held across harness reads.
 * Notifications and inbox-change signals fire AFTER the update, for
 * reopened/orphaned items only. A failing bucket lands in `errors` and
 * the sweep continues to the next bucket.
 */
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { EscalationStore } from "./store.js";
/** The registered task kind; the cron job's action names it. */
export declare const SWEEP_TASK_NAME = "escalations.sweep";
/** The 15-minute cron job the factory declares. */
export declare const SWEEP_JOB: {
    readonly name: "sweep";
    readonly schedule: {
        readonly every: "15m";
    };
    readonly action: {
        readonly kind: "task";
        readonly task: "escalations.sweep";
    };
};
export interface SweepReport {
    snoozesEnded: number;
    orphaned: number;
    claimsExpired: number;
    pruned: number;
    errors: string[];
    /** Buckets skipped after the abort signal fired. */
    stops?: number;
}
export interface SweepDeps {
    readonly host: SigrunHost;
    readonly store: EscalationStore;
    readonly now?: () => Date;
    /** Cooperative cancellation, checked between buckets (the task phase passes the invocation's runtime.signal). */
    readonly signal?: AbortSignal;
}
/** The sweep body, shared by the task phase and directly unit-testable. */
export declare function runSweep(deps: SweepDeps): Promise<SweepReport>;
/** The task object the extension registers. */
export declare function createSweepTask(deps: SweepDeps): import("@earendil-works/pi-durable").Task<unknown, {
    phase: "sweep";
}, unknown, object>;
