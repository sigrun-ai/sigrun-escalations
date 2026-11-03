import type { EscalationStore } from "./store.js";
import type { Bucket } from "./types.js";
/**
 * Copy selected items to a new owner before removing them from the source.
 * A crash between the updates leaves duplicates; the id check makes retrying
 * the copy idempotent, so a later delivery can finish without losing items.
 */
export declare function transferItems(store: EscalationStore, source: Bucket, target: Bucket, ids: ReadonlySet<string>, now: Date): Promise<readonly string[]>;
