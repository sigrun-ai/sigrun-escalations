import type {
	ExtensionRunSettledHandler,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import { changedInbox } from "./keys.js";
import { TransitionError, claim, release, reopen } from "./lifecycle.js";
import { notifyReopened } from "./notify.js";
import { EscalationStore, bucketFor } from "./store.js";
import type { Bucket, Escalation } from "./types.js";

export interface DispatchDeps {
	readonly host: SigrunHost;
	readonly store: EscalationStore;
	readonly now?: () => Date;
}

const RUN_ENDED = "run ended without resolving the escalation";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sourceText(e: Escalation, jobName?: string): string {
	if (e.source.jobId !== undefined) return `job "${jobName ?? e.source.jobId}" (${e.source.jobId})`;
	if (e.source.conversationId !== undefined) return `conversation #${e.source.conversationId}`;
	return "none";
}

/** Seed the fresh immediate-run conversation with the complete decision. */
export function seedText(e: Escalation, jobName?: string): string {
	const option = e.options.find((candidate) => candidate.id === e.answer?.option);
	const chosen = option === undefined
		? "none chosen"
		: `${option.label} (${option.id})`;
	return `You are acting on an answered escalation (id ${e.id}).\n\n` +
		`Title: ${e.title}\n` +
		`Source: ${sourceText(e, jobName)}\n\n` +
		`## Escalation\n${e.body}\n\n` +
		`## The user's answer\n` +
		`Chosen action: ${chosen}\n` +
		`Instruction: ${e.answer?.instruction ?? "none"}\n\n` +
		`Carry out the chosen action, following the instruction if one is given. When you are finished, call escalation_resolve with id "${e.id}", outcome "done" or "failed", and a short note. Do not raise a new escalation for this same issue.`;
}

async function reopenAnswer(
	deps: DispatchDeps,
	bucket: Bucket,
	id: string,
	note: string,
): Promise<Escalation | undefined> {
	return await deps.store.update(bucket, (items) => {
		let reopened: Escalation | undefined;
		const next = items.map((item) => {
			if (item.id !== id || item.status !== "answered") return item;
			reopened = reopen(item, note, deps.now?.() ?? new Date());
			return reopened;
		});
		return { items: reopened === undefined ? items : next, result: reopened };
	});
}

async function releaseClaim(
	deps: DispatchDeps,
	bucket: Bucket,
	id: string,
	conversationId: number,
	note: string,
): Promise<Escalation | undefined> {
	const now = deps.now?.() ?? new Date();
	return await deps.store.update(bucket, (items) => {
		let released: Escalation | undefined;
		const next = items.map((item) => {
			if (item.id !== id || item.status !== "claimed" || item.claim?.conversationId !== conversationId) {
				return item;
			}
			released = release(item, conversationId, note, now);
			return released;
		});
		return { items: released === undefined ? items : next, result: released };
	});
}

/** Create, claim, and seed one immediate run for an answered item. */
export async function startImmediateRun(
	deps: DispatchDeps,
	bucket: Bucket,
	id: string,
): Promise<number | undefined> {
	const { host, store } = deps;
	const existing = (await store.list(bucket)).find((item) => item.id === id);
	if (existing === undefined) return undefined;
	const job = existing.source.jobId === undefined
		? undefined
		: await host.jobs.get(existing.source.jobId);
	let conversationId;
	try {
		conversationId = await host.conversations.create({
			owner: job === undefined ? existing.owner : job.owner,
			name: `Escalation: ${existing.title}`.slice(0, 120),
			source: "escalations",
			...(job === undefined ? {} : { job: job.id }),
		});
	} catch (error) {
		const reopened = await reopenAnswer(
			deps,
			bucket,
			id,
			`dispatch failed: ${errorMessage(error)}`,
		);
		if (reopened !== undefined) {
			await notifyReopened(host, reopened);
			changedInbox(host, reopened.id);
		}
		return undefined;
	}

	const claimed = await store.update(bucket, (items) => {
		let nextClaim: Escalation | undefined;
		const next = items.map((item) => {
			if (item.id !== id) return item;
			try {
				nextClaim = claim(item, conversationId, deps.now?.() ?? new Date());
				return nextClaim;
			} catch (error) {
				if (error instanceof TransitionError) return item;
				throw error;
			}
		});
		return { items: nextClaim === undefined ? items : next, result: nextClaim };
	});
	if (claimed === undefined) return undefined;

	try {
		await host.conversations.submit(conversationId, [
			{ type: "text", text: seedText(existing, job?.name) },
		]);
		return conversationId;
	} catch (error) {
		const released = await releaseClaim(
			deps,
			bucket,
			id,
			conversationId,
			`dispatch failed: ${errorMessage(error)}`,
		);
		if (released !== undefined) {
			await notifyReopened(host, released);
			changedInbox(host, released.id);
		}
		return undefined;
	}
}

/** Release claims left unresolved by a settled run, isolating every failure. */
export function createRunSettled(deps: DispatchDeps): ExtensionRunSettledHandler {
	return async (event) => {
		try {
			const bucket = await bucketFor(deps.host, event.owner);
			const items = await deps.store.list(bucket);
			if (!items.some(
				(item) => item.status === "claimed" && item.claim?.conversationId === event.conversationId,
			)) return;
			const released = await deps.store.update(bucket, (current) => {
				const nextReleased: Escalation[] = [];
				const next = current.map((item) => {
					if (item.status !== "claimed" || item.claim?.conversationId !== event.conversationId) return item;
					const reopened = release(item, event.conversationId, RUN_ENDED, deps.now?.() ?? new Date());
					nextReleased.push(reopened);
					return reopened;
				});
				return { items: nextReleased.length === 0 ? current : next, result: nextReleased };
			});
			for (const item of released) {
				try {
					await notifyReopened(deps.host, item);
				} catch (error) {
					console.warn(`escalations: reopen notification failed for ${item.id}`, error);
				}
				try {
					changedInbox(deps.host, item.id);
				} catch (error) {
					console.warn(`escalations: inbox change notification failed for ${item.id}`, error);
				}
			}
		} catch (error) {
			console.warn(`escalations: runSettled failed for conversation ${event.conversationId}`, error);
		}
	};
}
