import type { EscalationStore } from "./store.js";
import type { Bucket } from "./types.js";
/**
 * Copy selected items to a new owner before removing them from the source.
 * A crash between the updates leaves duplicates. Only ids copied by this call
 * are removed from the source: a pre-existing target id is an unresolved
 * duplicate while the source still holds it, so both copies survive for retry.
 */
export declare function transferItems(store: EscalationStore, source: Bucket, target: Bucket, ids: ReadonlySet<string>, now: Date): Promise<readonly string[]>;
