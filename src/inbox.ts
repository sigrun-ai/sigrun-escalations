/**
 * The Inbox view (Task E6): the four-tab list (Open / In progress /
 * Dismissed / Resolved) and the per-item detail page, over the visible
 * buckets of the CALLING principal.
 *
 * - List rows carry a `source` label field and the collection groups on
 *   it, so the list groups by job / conversation / agent (spec §4.5).
 *   The open tab sorts reopened items first, then newest; resolved is
 *   newest first. An answered `next-run` item whose job is disabled
 *   shows the badge `Waiting: job disabled`.
 * - Split layout: the list is the page sidebar (tabs in the header),
 *   the selected item (params `{tab?, id}`) fills main, and the row
 *   being viewed carries a `Viewing` badge. An id with no tab lists the
 *   item's own tab; on compact widths the page's selection drill-in
 *   shows the list first.
 * - The detail (main) is a header callout with the item's actions, the
 *   markdown body, answer form (options in the agent's order, NONE marked
 *   recommended — the webui preselects recommended options and the
 *   proposed action may be destructive), snooze form seeded at 7 days
 *   (number fields have no `default` prop), Dismiss/Withdraw/Restore and
 *   conversation links on the header callout, and the history as a log.
 *   Orphaned items show only the pinned warn callout and Dismiss.
 * - Every action resolves the item through `findVisible` over the
 *   caller's buckets, so another user's id behaves exactly like an
 *   unknown id (no title leak). Successful actions call `changedInbox`.
 * - A store read failure renders a `bad` callout with the error message
 *   instead of the collection (the render never throws on corrupt data).
 */

import type {
	ActionResult,
	Principal,
	SigrunHost,
	SurfaceContext,
	SurfaceDef,
	SurfaceRenderResult,
} from "@sigrun/sigrun/extension";
import type { ActionButton, Block, Card, Field, Tree } from "@sigrun/shared/blocks";
import { startImmediateRun } from "./dispatch.js";
import { changedInbox } from "./keys.js";
import {
	TransitionError,
	answer,
	dismiss,
	restore,
	snooze,
	withdraw,
} from "./lifecycle.js";
import {
	EscalationStore,
	bucketsVisibleTo,
	findVisible,
} from "./store.js";
import type { Bucket, Escalation, EscalationStatus } from "./types.js";

export interface InboxDeps {
	readonly host: SigrunHost;
	readonly store: EscalationStore;
	readonly now?: () => Date;
}

type Tab = "open" | "active" | "dismissed" | "resolved";
const TABS: readonly { id: Tab; label: string }[] = [
	{ id: "open", label: "Open" },
	{ id: "active", label: "In progress" },
	{ id: "dismissed", label: "Dismissed" },
	{ id: "resolved", label: "Resolved" },
];
const ACTIVE_STATUSES: readonly EscalationStatus[] = ["answered", "claimed", "snoozed"];

/** The tab an item of this status lists under. */
function tabOf(status: EscalationStatus): Tab {
	if (status === "open") return "open";
	if (ACTIVE_STATUSES.includes(status)) return "active";
	if (status === "dismissed") return "dismissed";
	return "resolved";
}

/** One list row: the escalation plus its display fields. */
interface InboxRow {
	readonly id: string;
	readonly title: string;
	readonly source: string;
	readonly status: EscalationStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly resolvedAt?: string;
	readonly reopenReason?: Escalation["reopenReason"];
	/** Literal badge text, present only while the run is blocked. */
	readonly waitingBadge?: string;
	/** Literal badge text on the row shown in main. */
	readonly viewing?: string;
}

function isObject(payload: unknown): payload is Record<string, unknown> {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

function itemIdOf(payload: unknown): string | undefined {
	if (!isObject(payload)) return undefined;
	const itemId = payload.itemId;
	return typeof itemId === "string" && itemId !== "" ? itemId : undefined;
}

function valuesOf(payload: unknown): Record<string, unknown> {
	return isObject(payload) && isObject(payload.values) ? payload.values : {};
}

function idsOf(payload: unknown): string[] {
	if (!isObject(payload) || !Array.isArray(payload.ids)) return [];
	return payload.ids.filter((id): id is string => typeof id === "string" && id !== "");
}

/** Readable operator-facing text for each stable transition code. */
function transitionMessage(code: string): string {
	switch (code) {
		case "bad_days":
			return "Snooze days must be a whole number between 1 and 365.";
		case "orphaned":
			return "This escalation's job was deleted; only Dismiss is available.";
		case "empty_answer":
			return "Choose an option or write an instruction before sending.";
		case "unknown_option":
			return "That option is not one of the offered choices.";
		case "instruction_not_allowed":
			return "This escalation does not accept a free-text instruction.";
		case "not_open":
			return "Only an open escalation can be answered.";
		case "not_answered":
			return "Only an answered escalation can have its answer withdrawn.";
		case "not_dismissable":
			return "Only an open or answered escalation can be dismissed.";
		case "not_dismissed":
			return "Only a dismissed escalation can be restored.";
		case "not_snoozable":
			return "Only an open or answered escalation can be snoozed.";
		case "not_claimable":
			return "This escalation is not waiting to be claimed.";
		case "not_claimed":
			return "This escalation has no active claim.";
		case "wrong_claimant":
			return "Another conversation holds the claim on this escalation.";
		case "not_reopenable":
			return "This escalation cannot be reopened.";
		default:
			return "That change is not allowed in the escalation's current state.";
	}
}

function notFound(): ActionResult {
	return { ok: false, error: { message: "Escalation not found" } };
}

function failure(error: unknown): ActionResult {
	if (error instanceof TransitionError) {
		return { ok: false, error: { message: transitionMessage(error.code) } };
	}
	return {
		ok: false,
		error: { message: error instanceof Error ? error.message : String(error) },
	};
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The human source label a list row groups under. */
function sourceLabel(
	item: Escalation,
	jobName: string | undefined,
): string {
	if (item.source.jobId !== undefined) {
		if (item.orphaned === true) return "Job deleted";
		return jobName === undefined ? "Job deleted" : `Job ${jobName}`;
	}
	if (item.source.conversationId !== undefined) {
		return `Conversation #${item.source.conversationId}`;
	}
	return "Agent";
}

function historyLines(item: Escalation): { at: string; text: string }[] {
	return item.history.map((entry) => {
		const parts: string[] = [entry.event];
		if (entry.answer?.option !== undefined) parts.push(`option=${entry.answer.option}`);
		if (entry.answer?.by !== undefined) parts.push(`by=${entry.answer.by}`);
		if (entry.note !== undefined) parts.push(entry.note);
		return { at: entry.at, text: parts.join(" — ") };
	});
}

export function createInboxView(deps: InboxDeps): SurfaceDef<"view"> {
	const { host, store } = deps;
	const now = (): Date => deps.now?.() ?? new Date();

	async function jobOf(item: Escalation) {
		return item.source.jobId === undefined
			? undefined
			: await host.jobs.get(item.source.jobId);
	}

	/** List rows for one bucket, with job-derived display fields. */
	async function rowsFor(bucket: Bucket): Promise<InboxRow[]> {
		const items = await store.list(bucket);
		const rows: InboxRow[] = [];
		for (const item of items) {
			const job = await jobOf(item);
			rows.push({
				id: item.id,
				title: item.title,
				source: sourceLabel(item, job?.name),
				status: item.status,
				createdAt: item.createdAt,
				updatedAt: item.updatedAt,
				...(item.resolvedAt === undefined ? {} : { resolvedAt: item.resolvedAt }),
				...(item.reopenReason === undefined ? {} : { reopenReason: item.reopenReason }),
				...(item.status === "answered" && item.onAnswer === "next-run" && job?.enabled === false
					? { waitingBadge: "Waiting: job disabled" }
					: {}),
			});
		}
		return rows;
	}

	function sortForTab(rows: InboxRow[], tab: Tab): InboxRow[] {
		const filtered = rows.filter((row) =>
			tab === "open"
				? row.status === "open"
				: tab === "active"
					? ACTIVE_STATUSES.includes(row.status)
					: row.status === tab,
		);
		return filtered.sort((a, b) => {
			if (tab === "open") {
				const aReopened = a.reopenReason === undefined ? 0 : 1;
				const bReopened = b.reopenReason === undefined ? 0 : 1;
				if (aReopened !== bReopened) return bReopened - aReopened;
			}
			const aAt = tab === "resolved" ? (a.resolvedAt ?? a.updatedAt) : a.updatedAt;
			const bAt = tab === "resolved" ? (b.resolvedAt ?? b.updatedAt) : b.updatedAt;
			return bAt.localeCompare(aAt);
		});
	}

	/** The card template every tab's collection shares. */
	function cardTemplate(): Card {
		return {
			eyebrow: { $: "./source" },
			title: { $: "./title" },
			status: { label: { $: "./status" } },
			badges: [
				{ text: { $: "./reopenReason" }, tone: "warn" },
				// Empty badge text is filtered by the channel, so the waiting
				// badge shows only on rows that carry it.
				{ text: { $: "./waitingBadge" }, tone: "warn" },
				// Marks the row whose detail fills main (split layout).
				{ text: { $: "./viewing" }, tone: "accent" },
			],
			meta: [{ time: { $: "./updatedAt" }, format: "relative" }],
		};
	}

	function collectionFor(tab: Tab): Block {
		const bulk =
			tab === "open"
				? [{ id: "dismiss-many", label: "Dismiss selected", onSubmit: "dismiss-many" }]
				: tab === "dismissed"
					? [{ id: "restore-many", label: "Restore selected", onSubmit: "restore-many" }]
					: [];
		return {
			type: "collection",
			id: `inbox-${tab}`,
			display: "list",
			items: { $: "/items" },
			item: cardTemplate(),
			groupBy: "source",
			...(bulk.length === 0
				? {}
				: { select: "multi" as const, bulkActions: bulk }),
			onActivate: { type: "submit", name: "open" },
		};
	}

	/** The list column: the tab's collection, or the store-read error. */
	function sidebarBlocks(tab: Tab, error?: string): Block[] {
		return error === undefined
			? [collectionFor(tab)]
			: [
					{
						type: "callout",
						id: "inbox-error",
						tone: "bad",
						title: "The escalation store could not be read",
						body: error,
					},
				];
	}

	/** Main with nothing selected. */
	function placeholderMain(): Block[] {
		return [
			{
				type: "markdown",
				id: "inbox-select",
				text: "Select an escalation from the list to read it and answer.",
			},
		];
	}

	/** Main for an unknown id: identical for unknown and for invisible ids. */
	function notFoundMain(): Block[] {
		return [
			{
				type: "callout",
				id: "inbox-not-found-callout",
				tone: "bad",
				title: "Escalation not found",
			},
		];
	}

	/**
	 * The split page: tabs in the header, the list in the sidebar, the
	 * selection (or a placeholder) in main. On compact widths the
	 * `selection` drill-in shows the list first; back returns to the tab.
	 */
	function pageTree(tab: Tab, sidebar: Block[], main: Block[], selected: boolean): Tree {
		return {
			v: 1,
			root: {
				type: "page",
				id: "inbox-root",
				title: "Inbox",
				subtitle: TABS.find((entry) => entry.id === tab)?.label ?? "",
				actions: TABS.map((entry) => ({
					id: `tab-${entry.id}`,
					label: entry.label,
					action: { type: "navigate" as const, params: { tab: entry.id } },
				})),
				sidebar,
				main,
				selection: { selected, back: { tab } },
			},
		};
	}

	/** Main for one selected item: header card with its actions, body, forms, history. */
	function detailMain(item: Escalation, jobName: string | undefined): Block[] {
		const orphaned = item.orphaned === true;
		const actions: ActionButton[] = [];
		if (item.status === "open" || item.status === "answered") {
			actions.push({
				id: "dismiss",
				label: "Dismiss",
				action: {
					type: "submit",
					name: "dismiss",
					confirm: {
						title: "Dismiss this escalation?",
						body: "It will not come back unless you restore it. The job will skip this issue.",
						tone: "warn",
					},
				},
			});
		}
		if (item.status === "answered" && !orphaned) {
			actions.push({
				id: "withdraw",
				label: "Withdraw answer",
				action: { type: "submit", name: "withdraw" },
			});
		}
		if (item.status === "dismissed") {
			actions.push({
				id: "restore",
				label: "Restore",
				action: { type: "submit", name: "restore" },
			});
		}
		if (item.source.conversationId !== undefined) {
			actions.push({
				id: "source-conversation",
				label: "Source conversation",
				action: {
					type: "navigate",
					target: { conversation: item.source.conversationId },
				},
			});
		}
		if (item.claim !== undefined) {
			actions.push({
				id: "claim-conversation",
				label: "Claim conversation",
				action: {
					type: "navigate",
					target: { conversation: item.claim.conversationId },
				},
			});
		}

		const main: Block[] = [
			{
				type: "callout",
				id: "inbox-item",
				tone: "neutral",
				title: item.title,
				body: `${sourceLabel(item, jobName)} · ${item.status}`,
				actions,
			},
		];
		if (orphaned) {
			main.push({
				type: "callout",
				id: "inbox-orphaned",
				tone: "warn",
				title: "Job deleted",
				body: "This escalation's job was deleted. Nothing can act on it; dismiss it when you've read it.",
			});
		}
		main.push({ type: "markdown", id: "inbox-body", text: item.body });

		if (item.status === "open" && !orphaned) {
			const fields: Field[] = [
				{
					type: "choice",
					name: "option",
					label: "Choose an action",
					options: item.options.map((option) => ({
						id: option.id,
						label: option.label,
						...(option.detail === undefined ? {} : { description: option.detail }),
					})),
				},
			];
			if (item.allowInstruction) {
				fields.push({
					type: "longtext",
					name: "instruction",
					label: "Instruction (optional)",
				});
			}
			main.push({
				type: "form",
				id: "answer-form",
				bind: "/answer",
				mode: "submit",
				onSubmit: "answer",
				submitLabel: "Send answer",
				children: fields,
			});
		}
		if ((item.status === "open" || item.status === "answered") && !orphaned) {
			main.push({
				type: "form",
				id: "snooze-form",
				bind: "/snooze",
				mode: "submit",
				onSubmit: "snooze",
				submitLabel: "Snooze",
				children: [
					{
						type: "number",
						name: "days",
						label: "Days",
						min: 1,
						max: 365,
					},
				],
			});
		}
		main.push({
			type: "log",
			id: "inbox-history",
			lines: historyLines(item),
			wrap: true,
		});

		return main;
	}

	/** The shared action preamble: resolve the item inside the caller's buckets. */
	async function visibleItem(ctx: SurfaceContext, payload: unknown) {
		// Activation/bulk payloads carry {itemId}; detail forms and page
		// submits carry only {values, rev}, so the instance params name it.
		const id = itemIdOf(payload) ??
			(typeof ctx.params.id === "string" ? ctx.params.id : undefined);
		if (id === undefined) return undefined;
		const buckets = await bucketsVisibleTo(host, ctx.principal);
		return await findVisible(store, buckets, id);
	}

	/** Apply one lifecycle transition to a visible item and persist it. */
	async function transition(
		bucket: Bucket,
		id: string,
		apply: (item: Escalation) => Escalation,
	): Promise<Escalation> {
		return await store.update(bucket, (items) => {
			const next = items.map((item) => (item.id === id ? apply(item) : item));
			const updated = next.find((item) => item.id === id);
			if (updated === undefined) throw new TransitionError("not_found");
			return { items: next, result: updated };
		});
	}

	/** One single-item action: not-found uniformity, transitions, notification. */
	async function actOn(
		ctx: SurfaceContext,
		payload: unknown,
		apply: (found: { bucket: Bucket; item: Escalation }) => Promise<{
			toast: string;
			params?: { id: string } | { tab: string };
		}>,
	): Promise<ActionResult> {
		const found = await visibleItem(ctx, payload);
		if (found === undefined) return notFound();
		try {
			const outcome = await apply(found);
			changedInbox(host, found.item.id);
			return {
				ok: true,
				toast: outcome.toast,
				navigate: {
					type: "navigate",
					params: outcome.params ?? { id: found.item.id },
				},
			};
		} catch (error) {
			// The item vanished between findVisible and the update: the same
			// not-found body as an unknown id, never a raw error.
			if (error instanceof TransitionError && error.code === "not_found") {
				return notFound();
			}
			return failure(error);
		}
	}

	/** One bulk action: apply per id, skipping ids that are not actionable. */
	async function actOnMany(
		ctx: SurfaceContext,
		payload: unknown,
		apply: (found: { bucket: Bucket; item: Escalation }) => Promise<void>,
		label: string,
	): Promise<ActionResult> {
		const buckets = await bucketsVisibleTo(host, ctx.principal);
		let count = 0;
		for (const id of idsOf(payload)) {
			const found = await findVisible(store, buckets, id);
			if (found === undefined) continue;
			try {
				await apply(found);
				changedInbox(host, id);
				count += 1;
			} catch {
				// An invalid id or an inapplicable status skips that item.
			}
		}
		return { ok: true, toast: `${label} ${count} escalation${count === 1 ? "" : "s"}` };
	}

	return {
		id: "inbox",
		title: "Inbox",
		icon: "bell",
		placement: "view",
		render: async (ctx: SurfaceContext): Promise<SurfaceRenderResult> => {
			const buckets = await bucketsVisibleTo(host, ctx.principal);
			if (buckets.length === 0) {
				return {
					tree: {
						v: 1 as const,
						root: {
							type: "page" as const,
							id: "inbox-none",
							title: "Inbox",
							main: [
								{
									type: "markdown" as const,
									id: "inbox-none-text",
									text: "Sign in to see your escalations.",
								},
							],
						},
					},
					data: {},
					access: "none",
				};
			}

			const id = typeof ctx.params.id === "string" && ctx.params.id !== ""
				? ctx.params.id
				: undefined;
			const found = id === undefined ? undefined : await findVisible(store, buckets, id);
			const tabParam = ctx.params.tab;
			// An id with no tab (a notice or tool link) opens the list the
			// item lives in.
			const tab: Tab = TABS.some((entry) => entry.id === tabParam)
				? (tabParam as Tab)
				: found !== undefined
					? tabOf(found.item.status)
					: "open";

			let main: Block[];
			if (id === undefined) main = placeholderMain();
			else if (found === undefined) main = notFoundMain();
			else main = detailMain(found.item, (await jobOf(found.item))?.name);
			const selected = id !== undefined;
			const detailData = found === undefined ? {} : { answer: {}, snooze: { days: 7 } };

			try {
				const rows = (await Promise.all(buckets.map(rowsFor))).flat();
				const items = sortForTab(rows, tab).map((row) =>
					found !== undefined && row.id === found.item.id ? { ...row, viewing: "Viewing" } : row,
				);
				const data = { items, ...detailData };
				return {
					tree: pageTree(tab, sidebarBlocks(tab), main, selected),
					// SAFETY: rows are a JSON mirror (plain literals), same cast
					// the curator view uses for its data document.
					data: data as unknown as SurfaceRenderResult["data"],
					access: "write",
				};
			} catch (error) {
				return {
					tree: pageTree(tab, sidebarBlocks(tab, errorText(error)), main, selected),
					data: { error: errorText(error), ...detailData } as SurfaceRenderResult["data"],
					access: "write",
				};
			}
		},
		actions: {
			open: async (ctx, payload): Promise<ActionResult> => {
				const id = itemIdOf(payload);
				if (id === undefined) return notFound();
				// Keep the list the row was opened from beside the selection.
				const tab = TABS.some((entry) => entry.id === ctx.params.tab)
					? (ctx.params.tab as Tab)
					: undefined;
				return {
					ok: true,
					navigate: {
						type: "navigate",
						params: tab === undefined ? { id } : { tab, id },
					},
				};
			},
			answer: async (ctx, payload) =>
				await actOn(ctx, payload, async ({ bucket, item }) => {
					const values = valuesOf(payload);
					const option = typeof values.option === "string" ? values.option : undefined;
					const instruction =
						typeof values.instruction === "string" && values.instruction !== ""
							? values.instruction
							: undefined;
					await transition(bucket, item.id, (current) =>
						answer(
							current,
							{
								...(option === undefined ? {} : { option }),
								...(instruction === undefined ? {} : { instruction }),
								by: ctx.principal.user,
							},
							now(),
						),
					);
					if (item.onAnswer === "immediate") {
						// Reconstruct the dispatch seam explicitly: passing the view's
						// deps object would silently satisfy a diverging DispatchDeps
						// and would not prove the injected now() flows through.
						const conversationId = await startImmediateRun(
							{ host: deps.host, store: deps.store, now: deps.now },
							bucket,
							item.id,
						);
						if (conversationId !== undefined) {
							return { toast: "Answer sent — started a run" };
						}
						// The run could not start: the item reopened (dispatch's
						// contract), so never imply that a run is executing.
						return { toast: "Answer sent — no run started; it will reopen" };
					}
					return { toast: "Answer sent" };
				}),
			snooze: async (ctx, payload) =>
				await actOn(ctx, payload, async ({ bucket, item }) => {
					const days = valuesOf(payload).days;
					await transition(bucket, item.id, (current) =>
						snooze(current, typeof days === "number" ? days : Number.NaN, now()),
					);
					return { toast: "Snoozed" };
				}),
			dismiss: async (ctx, payload) =>
				await actOn(ctx, payload, async ({ bucket, item }) => {
					await transition(bucket, item.id, (current) => dismiss(current, now()));
					return { toast: "Dismissed", params: { tab: "open" } };
				}),
			withdraw: async (ctx, payload) =>
				await actOn(ctx, payload, async ({ bucket, item }) => {
					await transition(bucket, item.id, (current) => withdraw(current, now()));
					return { toast: "Answer withdrawn" };
				}),
			restore: async (ctx, payload) =>
				await actOn(ctx, payload, async ({ bucket, item }) => {
					await transition(bucket, item.id, (current) => restore(current, now()));
					return { toast: "Restored" };
				}),
			"dismiss-many": async (ctx, payload) =>
				await actOnMany(
					ctx,
					payload,
					async ({ bucket, item }) => {
						await transition(bucket, item.id, (current) => dismiss(current, now()));
					},
					"Dismissed",
				),
			"restore-many": async (ctx, payload) =>
				await actOnMany(
					ctx,
					payload,
					async ({ bucket, item }) => {
						await transition(bucket, item.id, (current) => restore(current, now()));
					},
					"Restored",
				),
		},
	};
}
