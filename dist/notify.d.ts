import type { SigrunHost } from "@sigrun/sigrun/extension";
import type { Escalation } from "./types.js";
export declare function notifyRaised(host: SigrunHost, e: Escalation): Promise<void>;
export declare function notifyReopened(host: SigrunHost, e: Escalation): Promise<void>;
export declare function notifyOrphaned(host: SigrunHost, e: Escalation): Promise<void>;
