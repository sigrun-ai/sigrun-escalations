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

import { defineTask } from "@earendil-works/pi-durable";
import type { HostJobInfo, SigrunHost } from "@sigrun/sigrun/extension";
import { changedInbox } from "./keys.js";
import { endSnooze, orphan, release } from "./lifecycle.js";
import { notifyOrphaned, notifyReopened } from "./notify.js";
import { EscalationStore, allBuckets, bucketFor } from "./store.js";
import { transferItems } from "./transfer.js";
import type { Bucket, Escalation } from "./types.js";

/** The registered task kind; the cron job's action names it. */
export const SWEEP_TASK_NAME = "escalations.sweep";

/** The 15-minute cron job the factory declares. */
export const SWEEP_JOB = {
	name: "sweep",
	schedule: { every: "15m" },
	action: { kind: "task", task: SWEEP_TASK_NAME },
} as const;

const DAY_MS = 86_400_000;
const CLAIM_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RESOLVED_RETENTION_MS = 90 * DAY_MS;
const CLAIM_TIMED_OUT = "claim timed out";

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

function jobIdOf(e: Escalation): string | undefined {
	return e.namespace.startsWith("job:")
		? e.namespace.slice("job:".length)
		: undefined;
}

interface BucketPlan {
	readonly items: readonly Escalation[];
	/** Every distinct job namespace in the bucket, resolved before the update. */
	readonly jobs: ReadonlyMap<string, HostJobInfo | undefined>;
}

/** Read-only planning pass: which jobs exist. Never holds the bucket queue. */
async function planSweep(
	deps: SweepDeps,
	bucket: Bucket,
	cache: Map<string, HostJobInfo | undefined>,
): Promise<BucketPlan> {
	const items = await deps.store.list(bucket);
	const jobs = new Map<string, HostJobInfo | undefined>();
	for (const item of items) {
		const jobId = jobIdOf(item);
		if (jobId === undefined || jobs.has(jobId)) continue;
		// The cache is sweep-wide: a job that spans two buckets is looked
		// up once, since host.jobs.get is idempotent.
		const cached = cache.get(jobId);
		if (cached !== undefined || cache.has(jobId)) {
			jobs.set(jobId, cached);
			continue;
		}
		const job = await deps.host.jobs.get(jobId);
		cache.set(jobId, job);
		jobs.set(jobId, job);
	}
	return { items, jobs };
}

/** Reconcile job-owned items into the buckets of their jobs' current owners. */
async function migrateTransferredJobs(
	deps: SweepDeps,
	bucket: Bucket,
	plan: BucketPlan,
	now: Date,
): Promise<readonly string[]> {
	const owner = bucket.kind === "user" ? bucket.user : undefined;
	const moved: string[] = [];
	for (const [jobId, job] of plan.jobs) {
		if (job === undefined || job.owner === owner) continue;
		const ids = new Set(
			plan.items.filter((item) => jobIdOf(item) === jobId).map((item) => item.id),
		);
		const transferred = await transferItems(deps.store, bucket, await bucketFor(deps.host, job.owner), ids, now);
		moved.push(...transferred);
	}
	return moved;
}

/** One atomic lifecycle update per source bucket: the four phases in order. */
async function sweepBucket(
	deps: SweepDeps,
	bucket: Bucket,
	plan: BucketPlan,
	now: Date,
): Promise<{ report: Omit<SweepReport, "errors">; reopened: Escalation[]; orphaned: Escalation[] }> {
	const reopened: Escalation[] = [];
	const orphaned: Escalation[] = [];
	return deps.store.update(bucket, (items) => {
		const next: Escalation[] = [];
		const report = { snoozesEnded: 0, orphaned: 0, claimsExpired: 0, pruned: 0 };
		for (const item of items) {
			// 4. Retention: drop resolved items older than 90 days.
			if (
				item.status === "resolved" &&
				item.resolvedAt !== undefined &&
				item.resolvedAt <= new Date(now.getTime() - RESOLVED_RETENTION_MS).toISOString()
			) {
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
			if (jobId !== undefined && plan.jobs.get(jobId) === undefined) {
				const nextOrphan = orphan(current, now);
				if (nextOrphan !== current) {
					current = nextOrphan;
					orphaned.push(current);
					report.orphaned += 1;
				}
			}

			// 3. Release claims older than 24h (orphaned claimed items stay
			// claimed until this timeout — see E1 reviewer note).
			if (
				current.status === "claimed" &&
				current.claim !== undefined &&
				current.claim.at <= new Date(now.getTime() - CLAIM_TIMEOUT_MS).toISOString()
			) {
				current = release(current, current.claim.conversationId, CLAIM_TIMED_OUT, now);
				report.claimsExpired += 1;
			}

			next.push(current);
		}
		return { items: next, result: { report, reopened, orphaned } };
	});
}

/** The sweep body, shared by the task phase and directly unit-testable. */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
	const now = deps.now?.() ?? new Date();
	const report: SweepReport = {
		snoozesEnded: 0,
		orphaned: 0,
		claimsExpired: 0,
		pruned: 0,
		errors: [],
	};
	const jobs = new Map<string, HostJobInfo | undefined>();
	for (const bucket of await allBuckets(deps.host)) {
		if (deps.signal?.aborted === true) {
			// Cooperative stop: the harness is closing or the task was
			// aborted; the next 15-minute tick sweeps the rest. `stops`
			// is set only on a real stop, keeping the base report shape.
			report.stops = (report.stops ?? 0) + 1;
			continue;
		}
		try {
			const plan = await planSweep(deps, bucket, jobs);
			const moved = await migrateTransferredJobs(deps, bucket, plan, now);
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
			// Migrated items changed bucket contents like a deletion does;
			// wake the inbox instances so the moved items render at once.
			for (const id of moved) changedInbox(deps.host, id);
		} catch (error) {
			const path = deps.store.fileOf(bucket);
			const message = error instanceof Error ? error.message : String(error);
			report.errors.push(`${path}: ${message}`);
			console.warn(`escalations: sweep failed for ${path}`, error);
		}
	}
	return report;
}

/** The task object the extension registers. */
export function createSweepTask(deps: SweepDeps) {
	return defineTask({
		name: SWEEP_TASK_NAME,
		version: 1,
		initial: () => ({ phase: "sweep" as const }),
		phases: {
			sweep: async (_task, runtime, context) => {
				await runSweep({ ...deps, signal: runtime.signal });
				// REQUIRED: a phase returning without durable progress faults the
				// task. The sweep's bookkeeping lives in the store files; the
				// task's own terminal outcome is the durable progress.
				await runtime.commit(
					() => ({
						status: "terminal" as const,
						outcome: { status: "completed" as const, result: undefined },
					}),
					context,
				);
			},
		},
		abort: async (_task, runtime, context) => {
			await runtime.commit(
				() => ({
					status: "terminal" as const,
					outcome: {
						status: "failed" as const,
						error: { message: "aborted" },
					},
				}),
				context,
			);
		},
	});
}
