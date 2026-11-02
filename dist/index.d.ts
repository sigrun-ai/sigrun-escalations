import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
/**
 * Build the complete escalation surface over one shared durable store.
 * The required host parameter keeps the factory at arity one for the loader.
 */
export default function createEscalations(host: SigrunHost): SigrunExtensionResult;
