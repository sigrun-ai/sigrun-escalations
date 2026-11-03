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
 * - Detail mode is a page titled with the escalation title: markdown
 *   body, answer form (options in the agent's order, NONE marked
 *   recommended — the webui preselects recommended options and the
 *   proposed action may be destructive), snooze form seeded at 7 days
 *   (number fields have no `default` prop), Dismiss/Withdraw/Restore as
 *   page actions, conversation links, and the history as a log block.
 *   Orphaned items show only the pinned warn callout and Dismiss.
 * - Every action resolves the item through `findVisible` over the
 *   caller's buckets, so another user's id behaves exactly like an
 *   unknown id (no title leak). Successful actions call `changedInbox`.
 * - A store read failure renders a `bad` callout with the error message
 *   instead of the collection (the render never throws on corrupt data).
 */
import { startImmediateRun } from "./dispatch.js";
import { changedInbox } from "./keys.js";
import { TransitionError, answer, dismiss, restore, snooze, withdraw, } from "./lifecycle.js";
import { bucketsVisibleTo, findVisible, } from "./store.js";
const TABS = [
    { id: "open", label: "Open" },
    { id: "active", label: "In progress" },
    { id: "dismissed", label: "Dismissed" },
    { id: "resolved", label: "Resolved" },
];
const ACTIVE_STATUSES = ["answered", "claimed", "snoozed"];
function isObject(payload) {
    return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}
function itemIdOf(payload) {
    if (!isObject(payload))
        return undefined;
    const itemId = payload.itemId;
    return typeof itemId === "string" && itemId !== "" ? itemId : undefined;
}
function valuesOf(payload) {
    return isObject(payload) && isObject(payload.values) ? payload.values : {};
}
function idsOf(payload) {
    if (!isObject(payload) || !Array.isArray(payload.ids))
        return [];
    return payload.ids.filter((id) => typeof id === "string" && id !== "");
}
/** Readable operator-facing text for each stable transition code. */
function transitionMessage(code) {
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
function notFound() {
    return { ok: false, error: { message: "Escalation not found" } };
}
function failure(error) {
    if (error instanceof TransitionError) {
        return { ok: false, error: { message: transitionMessage(error.code) } };
    }
    return {
        ok: false,
        error: { message: error instanceof Error ? error.message : String(error) },
    };
}
function errorText(error) {
    return error instanceof Error ? error.message : String(error);
}
/** The human source label a list row groups under. */
function sourceLabel(item, jobName) {
    if (item.source.jobId !== undefined) {
        if (item.orphaned === true)
            return "Job deleted";
        return jobName === undefined ? "Job deleted" : `Job ${jobName}`;
    }
    if (item.source.conversationId !== undefined) {
        return `Conversation #${item.source.conversationId}`;
    }
    return "Agent";
}
function historyLines(item) {
    return item.history.map((entry) => {
        const parts = [entry.event];
        if (entry.answer?.option !== undefined)
            parts.push(`option=${entry.answer.option}`);
        if (entry.answer?.by !== undefined)
            parts.push(`by=${entry.answer.by}`);
        if (entry.note !== undefined)
            parts.push(entry.note);
        return { at: entry.at, text: parts.join(" — ") };
    });
}
export function createInboxView(deps) {
    const { host, store } = deps;
    const now = () => deps.now?.() ?? new Date();
    async function jobOf(item) {
        return item.source.jobId === undefined
            ? undefined
            : await host.jobs.get(item.source.jobId);
    }
    /** List rows for one bucket, with job-derived display fields. */
    async function rowsFor(bucket) {
        const items = await store.list(bucket);
        const rows = [];
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
    function sortForTab(rows, tab) {
        const filtered = rows.filter((row) => tab === "open"
            ? row.status === "open"
            : tab === "active"
                ? ACTIVE_STATUSES.includes(row.status)
                : row.status === tab);
        return filtered.sort((a, b) => {
            if (tab === "open") {
                const aReopened = a.reopenReason === undefined ? 0 : 1;
                const bReopened = b.reopenReason === undefined ? 0 : 1;
                if (aReopened !== bReopened)
                    return bReopened - aReopened;
            }
            const aAt = tab === "resolved" ? (a.resolvedAt ?? a.updatedAt) : a.updatedAt;
            const bAt = tab === "resolved" ? (b.resolvedAt ?? b.updatedAt) : b.updatedAt;
            return bAt.localeCompare(aAt);
        });
    }
    /** The card template every tab's collection shares. */
    function cardTemplate() {
        return {
            eyebrow: { $: "./source" },
            title: { $: "./title" },
            status: { label: { $: "./status" } },
            badges: [
                { text: { $: "./reopenReason" }, tone: "warn" },
                // Empty badge text is filtered by the channel, so the waiting
                // badge shows only on rows that carry it.
                { text: { $: "./waitingBadge" }, tone: "warn" },
            ],
            meta: [{ time: { $: "./updatedAt" }, format: "relative" }],
        };
    }
    function collectionFor(tab) {
        const bulk = tab === "open"
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
                : { select: "multi", bulkActions: bulk }),
            onActivate: { type: "submit", name: "open" },
        };
    }
    function listTree(tab, error) {
        const main = error === undefined
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
        return {
            v: 1,
            root: {
                type: "page",
                id: "inbox-root",
                title: "Inbox",
                actions: TABS.map((entry) => ({
                    id: `tab-${entry.id}`,
                    label: entry.label,
                    action: { type: "navigate", params: { tab: entry.id } },
                })),
                main,
            },
        };
    }
    /** The not-found page: identical for unknown and for invisible ids. */
    function notFoundTree() {
        return {
            v: 1,
            root: {
                type: "page",
                id: "inbox-not-found",
                title: "Inbox",
                main: [
                    {
                        type: "callout",
                        id: "inbox-not-found-callout",
                        tone: "bad",
                        title: "Escalation not found",
                    },
                ],
            },
        };
    }
    function detailTree(item, jobName) {
        const orphaned = item.orphaned === true;
        const actions = [];
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
        const main = [];
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
            const fields = [
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
        return {
            v: 1,
            root: {
                type: "page",
                id: "inbox-detail",
                title: item.title,
                subtitle: sourceLabel(item, jobName),
                actions,
                main,
            },
        };
    }
    /** The shared action preamble: resolve the item inside the caller's buckets. */
    async function visibleItem(ctx, payload) {
        // Activation/bulk payloads carry {itemId}; detail forms and page
        // submits carry only {values, rev}, so the instance params name it.
        const id = itemIdOf(payload) ??
            (typeof ctx.params.id === "string" ? ctx.params.id : undefined);
        if (id === undefined)
            return undefined;
        const buckets = await bucketsVisibleTo(host, ctx.principal);
        return await findVisible(store, buckets, id);
    }
    /** Apply one lifecycle transition to a visible item and persist it. */
    async function transition(bucket, id, apply) {
        return await store.update(bucket, (items) => {
            const next = items.map((item) => (item.id === id ? apply(item) : item));
            const updated = next.find((item) => item.id === id);
            if (updated === undefined)
                throw new TransitionError("not_found");
            return { items: next, result: updated };
        });
    }
    /** One single-item action: not-found uniformity, transitions, notification. */
    async function actOn(ctx, payload, apply) {
        const found = await visibleItem(ctx, payload);
        if (found === undefined)
            return notFound();
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
        }
        catch (error) {
            // The item vanished between findVisible and the update: the same
            // not-found body as an unknown id, never a raw error.
            if (error instanceof TransitionError && error.code === "not_found") {
                return notFound();
            }
            return failure(error);
        }
    }
    /** One bulk action: apply per id, skipping ids that are not actionable. */
    async function actOnMany(ctx, payload, apply, label) {
        const buckets = await bucketsVisibleTo(host, ctx.principal);
        let count = 0;
        for (const id of idsOf(payload)) {
            const found = await findVisible(store, buckets, id);
            if (found === undefined)
                continue;
            try {
                await apply(found);
                changedInbox(host, id);
                count += 1;
            }
            catch {
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
        render: async (ctx) => {
            const buckets = await bucketsVisibleTo(host, ctx.principal);
            if (buckets.length === 0) {
                return {
                    tree: {
                        v: 1,
                        root: {
                            type: "page",
                            id: "inbox-none",
                            title: "Inbox",
                            main: [
                                {
                                    type: "markdown",
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
            const id = typeof ctx.params.id === "string" ? ctx.params.id : undefined;
            if (id !== undefined) {
                const found = await findVisible(store, buckets, id);
                if (found === undefined) {
                    // Nothing here can be acted on, so the page is not writable.
                    return { tree: notFoundTree(), data: {}, access: "none" };
                }
                const job = await jobOf(found.item);
                return {
                    tree: detailTree(found.item, job?.name),
                    data: { answer: {}, snooze: { days: 7 } },
                    access: "write",
                };
            }
            const tabParam = ctx.params.tab;
            const tab = TABS.some((entry) => entry.id === tabParam)
                ? tabParam
                : "open";
            try {
                const rows = (await Promise.all(buckets.map(rowsFor))).flat();
                const data = { items: sortForTab(rows, tab) };
                return {
                    tree: listTree(tab),
                    // SAFETY: rows are a JSON mirror (plain literals), same cast
                    // the curator view uses for its data document.
                    data: data,
                    access: "write",
                };
            }
            catch (error) {
                return {
                    tree: listTree(tab, errorText(error)),
                    data: { error: errorText(error) },
                    access: "write",
                };
            }
        },
        actions: {
            open: async (_ctx, payload) => {
                const id = itemIdOf(payload);
                if (id === undefined)
                    return notFound();
                return {
                    ok: true,
                    navigate: { type: "navigate", params: { id } },
                };
            },
            answer: async (ctx, payload) => await actOn(ctx, payload, async ({ bucket, item }) => {
                const values = valuesOf(payload);
                const option = typeof values.option === "string" ? values.option : undefined;
                const instruction = typeof values.instruction === "string" && values.instruction !== ""
                    ? values.instruction
                    : undefined;
                await transition(bucket, item.id, (current) => answer(current, {
                    ...(option === undefined ? {} : { option }),
                    ...(instruction === undefined ? {} : { instruction }),
                    by: ctx.principal.user,
                }, now()));
                if (item.onAnswer === "immediate") {
                    // Reconstruct the dispatch seam explicitly: passing the view's
                    // deps object would silently satisfy a diverging DispatchDeps
                    // and would not prove the injected now() flows through.
                    const conversationId = await startImmediateRun({ host: deps.host, store: deps.store, now: deps.now }, bucket, item.id);
                    if (conversationId !== undefined) {
                        return { toast: "Answer sent — started a run" };
                    }
                    // The run could not start: the item reopened (dispatch's
                    // contract), so never imply that a run is executing.
                    return { toast: "Answer sent — no run started; it will reopen" };
                }
                return { toast: "Answer sent" };
            }),
            snooze: async (ctx, payload) => await actOn(ctx, payload, async ({ bucket, item }) => {
                const days = valuesOf(payload).days;
                await transition(bucket, item.id, (current) => snooze(current, typeof days === "number" ? days : Number.NaN, now()));
                return { toast: "Snoozed" };
            }),
            dismiss: async (ctx, payload) => await actOn(ctx, payload, async ({ bucket, item }) => {
                await transition(bucket, item.id, (current) => dismiss(current, now()));
                return { toast: "Dismissed", params: { tab: "open" } };
            }),
            withdraw: async (ctx, payload) => await actOn(ctx, payload, async ({ bucket, item }) => {
                await transition(bucket, item.id, (current) => withdraw(current, now()));
                return { toast: "Answer withdrawn" };
            }),
            restore: async (ctx, payload) => await actOn(ctx, payload, async ({ bucket, item }) => {
                await transition(bucket, item.id, (current) => restore(current, now()));
                return { toast: "Restored" };
            }),
            "dismiss-many": async (ctx, payload) => await actOnMany(ctx, payload, async ({ bucket, item }) => {
                await transition(bucket, item.id, (current) => dismiss(current, now()));
            }, "Dismissed"),
            "restore-many": async (ctx, payload) => await actOnMany(ctx, payload, async ({ bucket, item }) => {
                await transition(bucket, item.id, (current) => restore(current, now()));
            }, "Restored"),
        },
    };
}
