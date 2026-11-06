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
import type { SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import { EscalationStore } from "./store.js";
export interface InboxDeps {
    readonly host: SigrunHost;
    readonly store: EscalationStore;
    readonly now?: () => Date;
}
export declare function createInboxView(deps: InboxDeps): SurfaceDef<"view">;
