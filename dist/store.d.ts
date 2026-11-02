import type { Principal, SigrunHost } from "@sigrun/sigrun/extension";
import type { Bucket, Escalation } from "./types.js";
/** Durable per-bucket escalation storage. */
export declare class EscalationStore {
    private readonly host;
    private readonly files;
    constructor(host: SigrunHost);
    fileOf(bucket: Bucket): string;
    list(bucket: Bucket): Promise<Escalation[]>;
    update<T>(bucket: Bucket, fn: (items: Escalation[]) => {
        items: Escalation[];
        result: T;
    }): Promise<T>;
    private fileFor;
}
export declare function bucketFor(host: SigrunHost, owner: string | undefined): Promise<Bucket>;
export declare function bucketsVisibleTo(host: SigrunHost, principal: Principal): Promise<Bucket[]>;
export declare function allBuckets(host: SigrunHost): Promise<Bucket[]>;
export declare function findVisible(store: EscalationStore, buckets: readonly Bucket[], id: string): Promise<{
    bucket: Bucket;
    item: Escalation;
} | undefined>;
