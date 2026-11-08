import type { EscalationStore } from "./store.js";
import type { Bucket } from "./types.js";

/**
 * Copy selected items to a new owner before removing them from the source.
 * A crash between the updates leaves duplicates. Only ids copied by this call
 * are removed from the source: a pre-existing target id is an unresolved
 * duplicate while the source still holds it, so both copies survive for retry.
 */
export async function transferItems(
	store: EscalationStore,
	source: Bucket,
	target: Bucket,
	ids: ReadonlySet<string>,
	now: Date,
): Promise<readonly string[]> {
	// Same-bucket transfer is a no-op; unreachable through bucketFor (a
	// job's owner resolves to its own bucket), but the guard keeps the
	// copy-then-remove shape honest for direct callers.
	if (
		(source.kind === "shared" && target.kind === "shared") ||
		(source.kind === "user" && target.kind === "user" && source.user === target.user)
	) {
		return [];
	}
	if (ids.size === 0) return [];
	const sourceItems = (await store.list(source)).filter((item) => ids.has(item.id));
	if (sourceItems.length === 0) return [];
	const sourceOwner = source.kind === "user" ? source.user : "shared";
	const targetOwner = target.kind === "user" ? target.user : undefined;

	const copiedIds = await store.update(target, (targetItems) => {
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
			result: new Set(additions.map((item) => item.id)),
		};
	});
	await store.update(source, (items) => ({
		items: items.filter((item) => !copiedIds.has(item.id)),
		result: undefined,
	}));
	return [...copiedIds];
}
