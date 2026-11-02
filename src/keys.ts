import type { SigrunHost } from "@sigrun/sigrun/extension";

export const INBOX_TABS = ["open", "active", "dismissed", "resolved"] as const;

/** Every inbox instance whose contents can change for this record. */
export function inboxKeys(id?: string): string[] {
	return [
		"{}",
		...INBOX_TABS.map((tab) => `{"tab":"${tab}"}`),
		...(id === undefined ? [] : [`{"id":${JSON.stringify(id)}}`]),
	];
}

/** Notify the surface host; this is deliberately fire-and-forget per its contract. */
export function changedInbox(host: SigrunHost, id?: string): void {
	for (const key of inboxKeys(id)) host.surfaces.changed("inbox", key);
}
