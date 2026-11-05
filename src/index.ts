import { defineExtension } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { createRunSettled } from "./dispatch.js";
import { createPublishedHooks } from "./hooks.js";
import { createInboxView } from "./inbox.js";
import { escalationsSection } from "./section.js";
import { EscalationStore } from "./store.js";
import { SWEEP_JOB, createSweepTask } from "./sweep.js";
import { transferItems } from "./transfer.js";
import { createTools } from "./tools.js";
import type { Bucket } from "./types.js";

export interface EscalationsOptions {
	/** Injectable clock for tests; every timestamp the extension stamps. */
	readonly now?: () => Date;
}

/**
 * Build the complete escalation surface over one shared durable store.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createEscalations(
	host: SigrunHost,
	options: EscalationsOptions = {},
): SigrunExtensionResult {
	const store = new EscalationStore(host);
	const deps = { host, store, now: options.now };
	return {
		extension: defineExtension({
			name: "escalations",
			tools: createTools(deps),
			sections: [escalationsSection],
			tasks: [createSweepTask(deps)],
		}),
		jobs: [SWEEP_JOB],
		runSettled: createRunSettled(deps),
		publishedHooks: createPublishedHooks(deps),
		surfaces: { views: [createInboxView(deps)] },
		userDeleted: async (event) => {
			const source: Bucket = { kind: "user", user: event.user };
			const target: Bucket = { kind: "user", user: event.transferTo };
			// Core emits userDeleted before removing the user from the directory
			// (src/server/routes/users.ts:303-305): host.stores.user(u) throws for
			// unknown users, so both bucket paths must be available here.
			const sourceItems = await store.list(source);
			await transferItems(
				store,
				source,
				target,
				new Set(sourceItems.map((item) => item.id)),
				deps.now?.() ?? new Date(),
			);
		},
	};
}
