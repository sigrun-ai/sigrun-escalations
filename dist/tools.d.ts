import { type ToolRegistration } from "@earendil-works/pi-durable";
import type { SigrunHost } from "@sigrun/sigrun/extension";
import { EscalationStore } from "./store.js";
export interface ToolDeps {
    readonly host: SigrunHost;
    readonly store: EscalationStore;
    readonly now?: () => Date;
}
/** Build the three host-identity-derived escalation tools over one store. */
export declare function createTools(deps: ToolDeps): ToolRegistration[];
