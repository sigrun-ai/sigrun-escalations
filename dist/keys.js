export const INBOX_TABS = ["open", "active", "dismissed", "resolved"];
/** Every inbox instance whose contents can change for this record. */
export function inboxKeys(id) {
    return [
        "{}",
        ...INBOX_TABS.map((tab) => `{"tab":"${tab}"}`),
        ...(id === undefined ? [] : [`{"id":${JSON.stringify(id)}}`]),
    ];
}
/** Notify the surface host; this is deliberately fire-and-forget per its contract. */
export function changedInbox(host, id) {
    for (const key of inboxKeys(id))
        host.surfaces.changed("inbox", key);
}
