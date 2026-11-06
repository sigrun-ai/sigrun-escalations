import { Type } from "typebox";
import type {
	PublishedHook,
	PublishedHookCall,
} from "@sigrun/sigrun/extension";
import type { DispatchDeps } from "./dispatch.js";
import { changedInbox } from "./keys.js";
import { TransitionError, claim, raise, resolve } from "./lifecycle.js";
import { notifyRaised, notifyReopened } from "./notify.js";
import { bucketFor } from "./store.js";
import type { Bucket } from "./types.js";

// Bounds mirror the escalate tool's parameters (tools.ts OptionSchema).
const OptionSchema = Type.Object({
	id: Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[a-z0-9][a-z0-9_-]{0,63}$",
	}),
	label: Type.String({ minLength: 1, maxLength: 200 }),
	detail: Type.Optional(Type.String({ maxLength: 2000 })),
});

const KeySchema = Type.String({ minLength: 1, maxLength: 200 });
const JobIdSchema = Type.Optional(Type.String({ minLength: 1 }));
const StatusSchema = Type.String();

interface RaisePayload {
	readonly key: string;
	readonly title: string;
	readonly body: string;
	readonly options: readonly { id: string; label: string; detail?: string }[];
	readonly allowInstruction?: boolean;
	readonly onAnswer?: "next-run" | "immediate";
	readonly jobId?: string;
}

interface TakePayload {
	readonly key: string;
	readonly jobId?: string;
}

interface ResolvePayload {
	readonly id: string;
	readonly outcome: "done" | "failed";
	readonly note?: string;
}

interface HookContext {
	readonly namespace: string;
	readonly bucket: Bucket;
}

async function context(
	deps: DispatchDeps,
	call: PublishedHookCall,
	jobId: string | undefined,
): Promise<HookContext> {
	if (call.conversationId === undefined) {
		throw new Error("escalation hooks need a conversation");
	}
	const meta = await deps.host.conversations.meta(call.conversationId);
	const effectiveJobId = jobId ?? meta.jobId;
	return {
		namespace: effectiveJobId === undefined ? "user" : `job:${effectiveJobId}`,
		bucket: await bucketFor(deps.host, meta.owner),
	};
}

/** Build the three published escalation hooks over one shared store. */
export function createPublishedHooks(deps: DispatchDeps): readonly PublishedHook[] {
	const now = deps.now ?? (() => new Date());

	const raiseHook: PublishedHook = {
		name: "escalation.raise",
		description:
			"Raise an asynchronous decision for the user. Dedups by namespace+key among unresolved items.",
		input: Type.Object({
			key: KeySchema,
			title: Type.String({ minLength: 1, maxLength: 200 }),
			body: Type.String({ minLength: 1, maxLength: 20_000 }),
			options: Type.Array(OptionSchema, { minItems: 1, maxItems: 8 }),
			allowInstruction: Type.Optional(Type.Boolean({ default: false })),
			onAnswer: Type.Optional(Type.Union([
				Type.Literal("next-run"),
				Type.Literal("immediate"),
			])),
			jobId: JobIdSchema,
		}),
		output: Type.Object({
			id: Type.String(),
			created: Type.Boolean(),
			status: StatusSchema,
		}),
		async run(payload, call) {
			const args = payload as RaisePayload;
			if (call.conversationId === undefined) {
				throw new Error("escalation hooks need a conversation");
			}
			const meta = await deps.host.conversations.meta(call.conversationId);
			const effectiveJobId = args.jobId ?? meta.jobId;
			const namespace = effectiveJobId === undefined ? "user" : `job:${effectiveJobId}`;
			const bucket = await bucketFor(deps.host, meta.owner);
			const onAnswer = args.onAnswer ?? (effectiveJobId === undefined ? "immediate" : "next-run");
			if (onAnswer === "next-run" && effectiveJobId === undefined) {
				throw new Error("escalation.raise: next-run needs a scheduled job run; use immediate");
			}
			const uniqueIds = new Set(args.options.map((option) => option.id));
			if (uniqueIds.size !== args.options.length) {
				throw new Error("escalation.raise: option ids must be unique");
			}
			const owner = bucket.kind === "user" ? bucket.user : undefined;

			// The lookup and insertion share the store's one serialized callback.
			const result = await deps.store.update(bucket, (items) => {
				const existing = items.find(
					(item) =>
						item.namespace === namespace &&
						item.key === args.key &&
						item.status !== "resolved",
				);
				if (existing !== undefined) {
					return { items, result: { item: existing, created: false } };
				}
				const item = raise(
					{
						...(owner === undefined ? {} : { owner }),
						namespace,
						key: args.key,
						title: args.title,
						body: args.body,
						options: [...args.options],
						allowInstruction: args.allowInstruction ?? false,
						onAnswer,
						source: {
							...(effectiveJobId === undefined ? {} : { jobId: effectiveJobId }),
							conversationId: call.conversationId,
						},
					},
					now(),
				);
				return { items: [...items, item], result: { item, created: true } };
			});
			if (result.created) {
				await notifyRaised(deps.host, result.item);
				changedInbox(deps.host, result.item.id);
			}
			return {
				id: result.item.id,
				created: result.created,
				status: result.item.status,
			};
		},
	};

	const takeHook: PublishedHook = {
		name: "escalation.take",
		description:
			"Claim an answered escalation for the calling conversation, or report its current status.",
		input: Type.Object({ key: KeySchema, jobId: JobIdSchema }),
		output: Type.Object({
			status: StatusSchema,
			id: Type.Optional(Type.String()),
			option: Type.Optional(Type.String()),
		}),
		async run(payload, call) {
			const args = payload as TakePayload;
			const { namespace, bucket } = await context(deps, call, args.jobId);
			const conversationId = call.conversationId!;
			// Take stays in the caller's bucket: another user's item is never
			// claimable (and its runSettled release sweep must not reach it).
			const found = await deps.store.update(bucket, (items) => {
				const item = items.find(
					(entry) =>
						entry.namespace === namespace &&
						entry.key === args.key &&
						entry.status !== "resolved",
				);
				if (item === undefined) return { items, result: undefined };
				if (
					item.status === "answered" ||
					(item.status === "claimed" && item.claim?.conversationId === conversationId)
				) {
					const claimed = claim(item, conversationId, now());
					// Idempotent re-claim returns the item unchanged: keep the
					// original array so the store's no-write fast path applies.
					const next =
						claimed === item
							? items
							: items.map((entry) => (entry === item ? claimed : entry));
					return {
						items: next,
						result: {
							status: "claimed",
							id: claimed.id,
							...(claimed.answer?.option === undefined
								? {}
								: { option: claimed.answer.option }),
						},
					};
				}
				return {
					items,
					result: {
						status: item.status,
						id: item.id,
						...(item.answer?.option === undefined
							? {}
							: { option: item.answer.option }),
					},
				};
			});
			return found ?? { status: "none" };
		},
	};

	const resolveHook: PublishedHook = {
		name: "escalation.resolve",
		description:
			"Resolve an escalation claimed by the calling conversation after carrying out its answer.",
		input: Type.Object({
			id: Type.String({ minLength: 1 }),
			outcome: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
			note: Type.Optional(Type.String({ maxLength: 4000, default: "" })),
		}),
		output: Type.Object({ status: StatusSchema }),
		async run(payload, call) {
			const args = payload as ResolvePayload;
			const { bucket } = await context(deps, call, undefined);
			const conversationId = call.conversationId!;
			// A TransitionError (wrong claimant / not claimed) propagates: the
			// caller sees `failed` with the code as the message.
			const item = await deps.store.update(bucket, (items) => {
				const index = items.findIndex((candidate) => candidate.id === args.id);
				if (index < 0) throw new TransitionError("not_found");
				const resolved = resolve(
					items[index]!,
					conversationId,
					args.outcome,
					args.note ?? "",
					now(),
				);
				const next = [...items];
				next[index] = resolved;
				return { items: next, result: resolved };
			});
			// Mirrors escalation_resolve: a failed claim reopens for the owner.
			if (args.outcome === "failed") await notifyReopened(deps.host, item);
			changedInbox(deps.host, item.id);
			return { status: item.status };
		},
	};

	return [raiseHook, takeHook, resolveHook];
}
