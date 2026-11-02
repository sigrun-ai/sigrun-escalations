/**
 * The escalation sweep task (`escalations.sweep`), fired by the `sweep`
 * cron job every 15 minutes. Pure host calls + store updates: no model,
 * no transcript content.
 *
 * Per bucket, ONE store.update: end due snoozes, orphan items whose job
 * was deleted, release claims older than 24h, and prune resolved items
 * older than 90 days. Job lookups are PREFETCHED before entering the
 * update so the bucket queue is never held across harness reads.
 * Notifications and inbox-change signals fire AFTER the update, for
 * reopened/orphaned items only. A failing bucket lands in `errors` and
 * the sweep continues to the next bucket.
 */
import { defineTask } from "@earendil-works/pi-durable";
import { changedInbox } from "./keys.js";
import { endSnooze, orphan, release } from "./lifecycle.js";
import { notifyOrphaned, notifyReopened } from "./notify.js";
import { allBuckets } from "./store.js";
/** The registered task kind; the cron job's action names it. */
export const SWEEP_TASK_NAME = "escalations.sweep";
/** The 15-minute cron job the factory declares. */
export const SWEEP_JOB = {
    name: "sweep",
    schedule: { every: "15m" },
    action: { kind: "task", task: SWEEP_TASK_NAME },
};
const DAY_MS = 86_400_000;
const CLAIM_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RESOLVED_RETENTION_MS = 90 * DAY_MS;
const CLAIM_TIMED_OUT = "claim timed out";
function jobIdOf(e) {
    return e.namespace.startsWith("job:")
        ? e.namespace.slice("job:".length)
        : undefined;
}
/** Read-only planning pass: which jobs exist. Never holds the bucket queue. */
async function planSweep(deps, bucket) {
    const items = await deps.store.list(bucket);
    const jobs = new Map();
    for (const item of items) {
        const jobId = jobIdOf(item);
        if (jobId === undefined || jobs.has(jobId))
            continue;
        const job = await deps.host.jobs.get(jobId);
        jobs.set(jobId, job !== undefined);
    }
    return { jobs };
}
/** One atomic update per bucket: the four lifecycle phases in order. */
async function sweepBucket(deps, bucket, plan, now) {
    const reopened = [];
    const orphaned = [];
    return deps.store.update(bucket, (items) => {
        const next = [];
        const report = { snoozesEnded: 0, orphaned: 0, claimsExpired: 0, pruned: 0 };
        for (const item of items) {
            // 4. Retention: drop resolved items older than 90 days.
            if (item.status === "resolved" &&
                item.resolvedAt !== undefined &&
                item.resolvedAt <= new Date(now.getTime() - RESOLVED_RETENTION_MS).toISOString()) {
                report.pruned += 1;
                continue;
            }
            let current = item;
            // 1. Snoozes due at or before now.
            const unsnoozed = endSnooze(current, now);
            if (unsnoozed !== current) {
                current = unsnoozed;
                reopened.push(current);
                report.snoozesEnded += 1;
            }
            // 2. Orphan items whose job no longer exists.
            const jobId = jobIdOf(current);
            if (jobId !== undefined && plan.jobs.get(jobId) === false) {
                const nextOrphan = orphan(current, now);
                if (nextOrphan !== current) {
                    current = nextOrphan;
                    orphaned.push(current);
                    report.orphaned += 1;
                }
            }
            // 3. Release claims older than 24h (orphaned claimed items stay
            // claimed until this timeout — see E1 reviewer note).
            if (current.status === "claimed" &&
                current.claim !== undefined &&
                current.claim.at <= new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString()) {
                current = release(current, current.claim.conversationId, CLAIM_TIMED_OUT, now);
                report.claimsExpired += 1;
            }
            next.push(current);
        }
        return { items: next, result: { report, reopened, orphaned } };
    });
}
/** The sweep body, shared by the task phase and directly unit-testable. */
export async function runSweep(deps) {
    const now = deps.now?.() ?? new Date();
    const report = {
        snoozesEnded: 0,
        orphaned: 0,
        claimsExpired: 0,
        pruned: 0,
        errors: [],
    };
    for (const bucket of await allBuckets(deps.host)) {
        try {
            const plan = await planSweep(deps, bucket);
            const outcome = await sweepBucket(deps, bucket, plan, now);
            report.snoozesEnded += outcome.report.snoozesEnded;
            report.orphaned += outcome.report.orphaned;
            report.claimsExpired += outcome.report.claimsExpired;
            report.pruned += outcome.report.pruned;
            // Notifications AFTER the update, only for reopened/orphaned items.
            for (const item of outcome.reopened) {
                await notifyReopened(deps.host, item);
                changedInbox(deps.host, item.id);
            }
            for (const item of outcome.orphaned) {
                await notifyOrphaned(deps.host, item);
                changedInbox(deps.host, item.id);
            }
        }
        catch (error) {
            const path = deps.store.fileOf(bucket);
            const message = error instanceof Error ? error.message : String(error);
            report.errors.push(`${path}: ${message}`);
            console.warn(`escalations: sweep failed for ${path}`, error);
        }
    }
    return report;
}
/** The task object the extension registers. */
export function createSweepTask(deps) {
    return defineTask({
        name: SWEEP_TASK_NAME,
        version: 1,
        initial: () => ({ phase: "sweep" }),
        phases: {
            sweep: async (_task, runtime, context) => {
                await runSweep(deps);
                // REQUIRED: a phase returning without durable progress faults the
                // task. The sweep's bookkeeping lives in the store files; the
                // task's own terminal outcome is the durable progress.
                await runtime.commit(() => ({
                    status: "terminal",
                    outcome: { status: "completed", result: undefined },
                }), context);
            },
        },
        abort: async (_task, runtime, context) => {
            await runtime.commit(() => ({
                status: "terminal",
                outcome: {
                    status: "failed",
                    error: { message: "aborted" },
                },
            }), context);
        },
    });
}
