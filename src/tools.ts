import { Type } from "@earendil-works/pi-ai";
import {
	defineTool,
	type ToolExecutionResult,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { changedInbox } from "./keys.js";
import { TransitionError, claim, isSkip, raise, resolve } from "./lifecycle.js";
import { notifyRaised, notifyReopened } from "./notify.js";
import { EscalationStore, bucketFor } from "./store.js";
import type { Escalation, EscalationOption } from "./types.js";

export interface ToolDeps {
	readonly host: SigrunHost;
	readonly store: EscalationStore;
	readonly now?: () => Date;
}

const OptionSchema = Type.Object({
	id: Type.String({
		minLength: 1,
		maxLength: 64,
		pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
	}),
	label: Type.String({ minLength: 1, maxLength: 200 }),
	detail: Type.Optional(Type.String({ maxLength: 2000 })),
});

const AnswerSchema = Type.Object({
	option: Type.Optional(Type.String()),
	instruction: Type.Optional(Type.String()),
	by: Type.Optional(Type.String()),
	at: Type.String(),
});

const ActSchema = Type.Object({
	id: Type.String(),
	key: Type.String(),
	title: Type.String(),
	body: Type.String(),
	options: Type.Array(OptionSchema),
	answer: AnswerSchema,
});

function textResult(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

function errorResult(text: string): ToolExecutionResult {
	return { ...textResult(text), isError: true };
}

function transitionCode(error: unknown): string {
	return error instanceof TransitionError
		? error.code
		: error instanceof Error
			? error.message
			: String(error);
}

function answerText(e: Escalation): string {
	const answer = e.answer;
	if (answer === undefined) return "none";
	return [
		answer.option === undefined ? undefined : `option: ${answer.option}`,
		answer.instruction === undefined ? undefined : `instruction: ${answer.instruction}`,
	]
		.filter((part): part is string => part !== undefined)
		.join("; ");
}

function listText(skip: readonly string[], act: readonly Escalation[]): string {
	return [
		"## Skip",
		...(skip.length === 0 ? ["(none)"] : skip.map((key) => `- ${key}`)),
		"## Act",
		...(act.length === 0
			? ["(none)"]
			: act.flatMap((e) => [
					`- ${e.id} — ${e.title} (${e.key})`,
					`  Body: ${e.body}`,
					`  Answer: ${answerText(e)}`,
				])),
	].join("\n");
}

/** Build the three host-identity-derived escalation tools over one store. */
export function createTools(deps: ToolDeps): ToolRegistration[] {
	const now = deps.now ?? (() => new Date());
	const caller = async (conversationId: number) => {
		const meta = await deps.host.conversations.meta(
			conversationId as Parameters<SigrunHost["conversations"]["meta"]>[0],
		);
		return {
			meta,
			namespace: meta.jobId === undefined ? "user" : `job:${meta.jobId}`,
			bucket: await bucketFor(deps.host, meta.owner),
		};
	};

	const escalate = defineTool({
		name: "escalate",
		description:
			"Raise an asynchronous decision for the user. Use a stable issue key; an unresolved item with the same key is returned instead of duplicated.",
		parameters: Type.Object({
			key: Type.String({ minLength: 1, maxLength: 200 }),
			title: Type.String({ minLength: 1, maxLength: 200 }),
			body: Type.String({ minLength: 1, maxLength: 20_000 }),
			options: Type.Array(OptionSchema, { minItems: 1, maxItems: 8 }),
			allowInstruction: Type.Optional(Type.Boolean({ default: true })),
			onAnswer: Type.Optional(Type.Union([
				Type.Literal("next-run"),
				Type.Literal("immediate"),
			])),
		}),
		replay: "safe",
		structuredOutputSchema: Type.Object({
			id: Type.String(),
			created: Type.Boolean(),
			status: Type.String(),
		}),
		async execute(args, api) {
			const { meta, namespace, bucket } = await caller(api.conversationId);
			const onAnswer = args.onAnswer ?? (meta.jobId === undefined ? "immediate" : "next-run");
			if (onAnswer === "next-run" && meta.jobId === undefined) {
				return errorResult("next-run needs a scheduled job run; use immediate");
			}
			const owner = bucket.kind === "user" ? bucket.user : undefined;
			const uniqueIds = new Set(args.options.map((option) => option.id));
			if (uniqueIds.size !== args.options.length) {
				return errorResult("escalate: option ids must be unique");
			}

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
						options: args.options,
						allowInstruction: args.allowInstruction ?? true,
						onAnswer,
						source: {
							...(meta.jobId === undefined ? {} : { jobId: meta.jobId }),
							conversationId: api.conversationId,
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
			const structuredOutput = {
				id: result.item.id,
				created: result.created,
				status: result.item.status,
			};
			return {
				output: [{
					type: "text",
					text: result.created
						? `Escalation ${result.item.id} raised.`
						: `Escalation ${result.item.id} already exists (status ${result.item.status}); not raised again.`,
				}],
				structuredOutput,
			};
		},
	});

	const escalationList = defineTool({
		name: "escalation_list",
		description:
			"List this job run's escalation keys to skip and answered next-run items to act on. Cron runs claim actionable items; other callers only see claims they already hold.",
		parameters: Type.Object({}),
		replay: "safe",
		structuredOutputSchema: Type.Object({
			skip: Type.Array(Type.String()),
			act: Type.Array(ActSchema),
		}),
		async execute(_args, api) {
			const { meta, namespace, bucket } = await caller(api.conversationId);
			// Claiming and skip/act projection are one atomic check-then-write.
			const result = await deps.store.update(bucket, (items) => {
				let changed = false;
				const next = items.map((item) => {
					if (
						meta.source === "cron" &&
						item.namespace === namespace &&
						item.status === "answered" &&
						item.onAnswer === "next-run"
					) {
						changed = true;
						return claim(item, api.conversationId, now());
					}
					return item;
				});
				const visible = changed ? next : items;
				const skip = visible
					.filter(
						(item) =>
							item.namespace === namespace &&
							isSkip(item) &&
							item.claim?.conversationId !== api.conversationId,
					)
					.map((item) => item.key);
				const act = visible.filter(
					(item) =>
						item.namespace === namespace &&
						item.status === "claimed" &&
						item.claim?.conversationId === api.conversationId,
				);
				return { items: visible, result: { skip, act } };
			});
			return {
				output: [{ type: "text", text: listText(result.skip, result.act) }],
				structuredOutput: {
					skip: result.skip,
					act: result.act.map((item) => ({
						id: item.id,
						key: item.key,
						title: item.title,
						body: item.body,
						options: item.options.map((option) => ({ ...option })),
						answer: { ...(item.answer ?? { at: item.updatedAt }) },
					})),
				},
			};
		},
	});

	const escalationResolve = defineTool({
		name: "escalation_resolve",
		description:
			"Resolve an escalation claimed by this conversation after carrying out its answer, or return it to open when the action failed.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1 }),
			outcome: Type.Union([Type.Literal("done"), Type.Literal("failed")]),
			note: Type.String({ minLength: 1, maxLength: 2000 }),
		}),
		replay: "safe",
		structuredOutputSchema: Type.Object({
			id: Type.String(),
			status: Type.String(),
		}),
		async execute(args, api) {
			const { bucket } = await caller(api.conversationId);
			try {
				// Finding the id and checking its claimant precede the same write.
				const item = await deps.store.update(bucket, (items) => {
					const index = items.findIndex((candidate) => candidate.id === args.id);
					if (index < 0) throw new TransitionError("not_found");
					const resolved = resolve(items[index] as Escalation, api.conversationId, args.outcome, args.note, now());
					const next = [...items];
					next[index] = resolved;
					return { items: next, result: resolved };
				});
				if (args.outcome === "failed") await notifyReopened(deps.host, item);
				changedInbox(deps.host, item.id);
				return {
					output: [{
						type: "text",
						text: args.outcome === "done"
							? `Escalation ${item.id} resolved.`
							: `Escalation ${item.id} reopened (status ${item.status}).`,
					}],
					structuredOutput: { id: item.id, status: item.status },
				};
			} catch (error) {
				return errorResult(`escalation_resolve: ${transitionCode(error)}`);
			}
		},
	});

	return [escalate, escalationList, escalationResolve];
}
