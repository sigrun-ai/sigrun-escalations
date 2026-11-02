import type { EscalationStore } from "./store.js";
import type { Bucket } from "./types.js";

/**
 * Copy selected items to a new owner before removing them from the source.
 * A crash between the updates leaves duplicates; the id check makes retrying
 * the copy idempotent, so a later delivery can finish without losing items.
 */
export async function transferItems(
	store: EscalationStore,
	source: Bucket,
	target: Bucket,
	ids: ReadonlySet<string>,
	now: Date,
): Promise<void> {
	if (ids.size === 0) return;
	const sourceItems = (await store.list(source)).filter((item) => ids.has(item.id));
	if (sourceItems.length === 0) return;
	const sourceOwner = source.kind === "user" ? source.user : "shared";
	const targetOwner = target.kind === "user" ? target.user : undefined;

	const idsInTarget = await store.update(target, (targetItems) => {
		const held = new Set(targetItems.map((item) => item.id));
		const additions = sourceItems
			.filter((item) => !held.has(item.id))
			.map((item) => ({
				...item,
				owner: targetOwner,
				history: [
					...item.history,
					{
						at: now.toISOString(),
						event: "transferred" as const,
						note: `transferred from ${sourceOwner}`,
					},
				],
			}));
		return {
			items: additions.length === 0
				? targetItems
				: [...targetItems, ...additions],
			result: new Set([...held, ...additions.map((item) => item.id)]),
		};
	});
	await store.update(source, (items) => ({
		items: items.filter((item) => !idsInTarget.has(item.id)),
		result: undefined,
	}));
}
