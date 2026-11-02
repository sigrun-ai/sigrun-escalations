import type { ExtensionRunSettledHandler, SigrunHost } from "@sigrun/sigrun/extension";
import { EscalationStore } from "./store.js";
import type { Bucket, Escalation } from "./types.js";
export interface DispatchDeps {
    readonly host: SigrunHost;
    readonly store: EscalationStore;
    readonly now?: () => Date;
}
/** Seed the fresh immediate-run conversation with the complete decision. */
export declare function seedText(e: Escalation, jobName?: string): string;
/** Create, claim, and seed one immediate run for an answered item. */
export declare function startImmediateRun(deps: DispatchDeps, bucket: Bucket, id: string): Promise<number | undefined>;
/** Release claims left unresolved by a settled run, isolating every failure. */
export declare function createRunSettled(deps: DispatchDeps): ExtensionRunSettledHandler;
