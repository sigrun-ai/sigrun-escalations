import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
export interface EscalationsOptions {
    /** Injectable clock for tests; every timestamp the extension stamps. */
    readonly now?: () => Date;
}
/**
 * Build the complete escalation surface over one shared durable store.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createEscalations(host: SigrunHost, options?: EscalationsOptions): SigrunExtensionResult;
