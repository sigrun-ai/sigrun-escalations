import type { PublishedHook } from "@sigrun/sigrun/extension";
import type { DispatchDeps } from "./dispatch.js";
/** Build the three published escalation hooks over one shared store. */
export declare function createPublishedHooks(deps: DispatchDeps): readonly PublishedHook[];
