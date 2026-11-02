import { defineExtension } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { createRunSettled } from "./dispatch.js";
import { createInboxView } from "./inbox.js";
import { escalationsSection } from "./section.js";
import { EscalationStore } from "./store.js";
import { SWEEP_JOB, createSweepTask } from "./sweep.js";
import { createTools } from "./tools.js";
import type { Bucket } from "./types.js";

/**
 * Build the complete escalation surface over one shared durable store.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createEscalations(host: SigrunHost): SigrunExtensionResult {
	const store = new EscalationStore(host);
	const deps = { host, store };
	return {
		extension: defineExtension({
			name: "escalations",
			tools: createTools(deps),
			sections: [escalationsSection],
			tasks: [createSweepTask(deps)],
		}),
		jobs: [SWEEP_JOB],
		runSettled: createRunSettled(deps),
		surfaces: { views: [createInboxView(deps)] },
		userDeleted: async (event) => {
			const source: Bucket = { kind: "user", user: event.user };
			const target: Bucket = { kind: "user", user: event.transferTo };
			// Core emits userDeleted before removing the user from the directory
			// (src/server/routes/users.ts:303-305): host.stores.user(u) throws for
			// unknown users, so both bucket paths must be available here.
			const sourceItems = await store.list(source);

			// Copy before removing: a crash between these updates leaves duplicates,
			// which this idempotent copy resolves on the next delivery, never a loss.
			const idsInTarget = await store.update(target, (targetItems) => {
				const held = new Set(targetItems.map((item) => item.id));
				const additions = sourceItems
					.filter((item) => !held.has(item.id))
					.map((item) => ({
						...item,
						owner: event.transferTo,
						history: [
							...item.history,
							{
								at: new Date().toISOString(),
								event: "transferred" as const,
								note: `transferred from ${event.user}`,
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
		},
	};
}
