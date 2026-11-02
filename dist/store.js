import { join } from "node:path";
import { JsonFile } from "./json-file.js";
/** Durable per-bucket escalation storage. */
export class EscalationStore {
    host;
    // One JsonFile per path is essential: its serialization queue is per
    // instance, so constructing one per update would permit lost updates.
    files = new Map();
    constructor(host) {
        this.host = host;
    }
    fileOf(bucket) {
        return join(bucket.kind === "user"
            ? this.host.stores.user(bucket.user).paths.data
            : this.host.stores.paths.data, "escalations.json");
    }
    list(bucket) {
        return this.fileFor(bucket).read();
    }
    async update(bucket, fn) {
        let result;
        await this.fileFor(bucket).update((items) => {
            const next = fn(items);
            result = next.result;
            // JsonFile treats an unchanged array reference as the no-write fast path.
            return next.items;
        });
        return result;
    }
    fileFor(bucket) {
        const path = this.fileOf(bucket);
        let file = this.files.get(path);
        if (file === undefined) {
            file = new JsonFile(path, () => []);
            this.files.set(path, file);
        }
        return file;
    }
}
export async function bucketFor(host, owner) {
    if (owner !== undefined && (await host.users.get(owner)) !== undefined) {
        return { kind: "user", user: owner };
    }
    const primaryAdmin = (await host.users.list()).find((user) => user.admin);
    return primaryAdmin === undefined
        ? { kind: "shared" }
        : { kind: "user", user: primaryAdmin.user };
}
export async function bucketsVisibleTo(host, principal) {
    // Core's naive-loopback superuser and service token carry no user
    // (src/server/auth/principal.ts:27-30), so they see the shared bucket.
    if (principal.user === undefined)
        return [{ kind: "shared" }];
    return (await host.users.get(principal.user)) === undefined
        ? []
        : [{ kind: "user", user: principal.user }];
}
export async function allBuckets(host) {
    return [
        ...(await host.users.list()).map((user) => ({ kind: "user", user: user.user })),
        { kind: "shared" },
    ];
}
export async function findVisible(store, buckets, id) {
    for (const bucket of buckets) {
        const item = (await store.list(bucket)).find((candidate) => candidate.id === id);
        if (item !== undefined)
            return { bucket, item };
    }
    return undefined;
}
