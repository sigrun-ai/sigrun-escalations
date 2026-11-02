import { join } from "node:path";
import type { Principal, SigrunHost } from "@sigrun/sigrun/extension";
import { JsonFile } from "./json-file.js";
import type { Bucket, Escalation } from "./types.js";

/** Durable per-bucket escalation storage. */
export class EscalationStore {
	// One JsonFile per path is essential: its serialization queue is per
	// instance, so constructing one per update would permit lost updates.
	private readonly files = new Map<string, JsonFile<Escalation[]>>();

	constructor(private readonly host: SigrunHost) {}

	fileOf(bucket: Bucket): string {
		return join(
			bucket.kind === "user"
				? this.host.stores.user(bucket.user).paths.data
				: this.host.stores.paths.data,
			"escalations.json",
		);
	}

	list(bucket: Bucket): Promise<Escalation[]> {
		return this.fileFor(bucket).read();
	}

	async update<T>(
		bucket: Bucket,
		fn: (items: Escalation[]) => { items: Escalation[]; result: T },
	): Promise<T> {
		let result!: T;
		await this.fileFor(bucket).update((items) => {
			const next = fn(items);
			result = next.result;
			// JsonFile treats an unchanged array reference as the no-write fast path.
			return next.items;
		});
		return result;
	}

	private fileFor(bucket: Bucket): JsonFile<Escalation[]> {
		const path = this.fileOf(bucket);
		let file = this.files.get(path);
		if (file === undefined) {
			file = new JsonFile<Escalation[]>(path, () => []);
			this.files.set(path, file);
		}
		return file;
	}
}

export async function bucketFor(
	host: SigrunHost,
	owner: string | undefined,
): Promise<Bucket> {
	if (owner !== undefined && (await host.users.get(owner)) !== undefined) {
		return { kind: "user", user: owner };
	}
	const primaryAdmin = (await host.users.list()).find((user) => user.admin);
	return primaryAdmin === undefined
		? { kind: "shared" }
		: { kind: "user", user: primaryAdmin.user };
}

export async function bucketsVisibleTo(
	host: SigrunHost,
	principal: Principal,
): Promise<Bucket[]> {
	// Core's naive-loopback superuser and service token carry no user
	// (src/server/auth/principal.ts:27-30), so they see the shared bucket.
	if (principal.user === undefined) return [{ kind: "shared" }];
	return (await host.users.get(principal.user)) === undefined
		? []
		: [{ kind: "user", user: principal.user }];
}

export async function allBuckets(host: SigrunHost): Promise<Bucket[]> {
	return [
		...(await host.users.list()).map(
			(user): Bucket => ({ kind: "user", user: user.user }),
		),
		{ kind: "shared" },
	];
}

export async function findVisible(
	store: EscalationStore,
	buckets: readonly Bucket[],
	id: string,
): Promise<{ bucket: Bucket; item: Escalation } | undefined> {
	for (const bucket of buckets) {
		const item = (await store.list(bucket)).find((candidate) => candidate.id === id);
		if (item !== undefined) return { bucket, item };
	}
	return undefined;
}
