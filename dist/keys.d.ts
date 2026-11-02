import type { SigrunHost } from "@sigrun/sigrun/extension";
export declare const INBOX_TABS: readonly ["open", "active", "dismissed", "resolved"];
/** Every inbox instance whose contents can change for this record. */
export declare function inboxKeys(id?: string): string[];
/** Notify the surface host; this is deliberately fire-and-forget per its contract. */
export declare function changedInbox(host: SigrunHost, id?: string): void;
