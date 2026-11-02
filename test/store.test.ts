import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "@sigrun/sigrun/extension";
import { raise } from "../src/lifecycle.js";
import {
	EscalationStore,
	allBuckets,
	bucketFor,
	bucketsVisibleTo,
	findVisible,
} from "../src/store.js";
import type { Bucket, Escalation } from "../src/types.js";
import {
	createFakeHost,
	type FakeHost,
	type FakeHostOptions,
} from "./fake-host.js";

const ALICE: Bucket = { kind: "user", user: "alice" };
const ROOT_ADMIN: Bucket = { kind: "user", user: "root-admin" };
const SHARED: Bucket = { kind: "shared" };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const hosts: FakeHost[] = [];

async function fakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
	const host = await createFakeHost(opts);
	hosts.push(host);
	return host;
}

function item(id: string, owner = "alice"): Escalation {
	return {
		...raise(
			{
				owner,
				namespace: "job:nightly-check",
				key: "disk:/srv/a",
				title: "Disk needs attention",
				body: "The nightly check found that the disk is nearly full.",
				options: [{ id: "retry", label: "Retry the check" }],
				allowInstruction: true,
				onAnswer: "next-run",
				source: { jobId: "nightly-check" },
			},
			NOW,
		),
		id,
	};
}

function principal(user: string | undefined): Principal {
	return { user, admin: false, service: false, method: "none" };
}

afterEach(async () => {
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

describe("EscalationStore persistence", () => {
	it("lists an absent file as an empty bucket", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);

		await expect(store.list(ALICE)).resolves.toEqual([]);
	});

	it("uses the user and shared host data paths", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);

		expect(store.fileOf(ALICE)).toBe(
			join(host.stores.user("alice").paths.data, "escalations.json"),
		);
		expect(store.fileOf(SHARED)).toBe(
			join(host.stores.paths.data, "escalations.json"),
		);
	});

	it("serializes 20 concurrent updates through the store API", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);

		const results = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				store.update(ALICE, (items) => {
					const next = item(`item-${index}`);
					return { items: [...items, next], result: next.id };
				}),
			),
		);

		const stored = await store.list(ALICE);
		expect(results).toHaveLength(20);
		expect(stored).toHaveLength(20);
		expect(stored.map((entry) => entry.id).sort()).toEqual(
			Array.from({ length: 20 }, (_, index) => `item-${index}`).sort(),
		);
	});

	it("rejects list and update naming a malformed file without changing its bytes", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);
		const path = store.fileOf(ALICE);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "{not json");
		const before = await readFile(path);

		await expect(store.list(ALICE)).rejects.toThrow(path);
		await expect(
			store.update(ALICE, (items) => ({ items, result: "unused" })),
		).rejects.toThrow(path);
		expect(await readFile(path)).toEqual(before);
	});

	it("writes files with mode 0600", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);

		await store.update(ALICE, (items) => ({
			items: [...items, item("private")],
			result: undefined,
		}));

		expect((await stat(store.fileOf(ALICE))).mode & 0o777).toBe(0o600);
	});

	it("does not replace the file when an update returns the same items reference", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);
		const path = store.fileOf(ALICE);
		await store.update(ALICE, (items) => ({
			items: [...items, item("existing")],
			result: undefined,
		}));
		const before = await stat(path);

		await expect(
			store.update(ALICE, (items) => ({ items, result: "unchanged" })),
		).resolves.toBe("unchanged");
		expect((await stat(path)).ino).toBe(before.ino);
	});
});

describe("bucket selection and visibility", () => {
	it("resolves known owners, ghosts, and undefined owners with a stored admin", async () => {
		const host = await fakeHost({
			users: [
				{ user: "root-admin", admin: true },
				{ user: "alice", admin: false },
			],
		});

		await expect(bucketFor(host, "alice")).resolves.toEqual(ALICE);
		await expect(bucketFor(host, "ghost")).resolves.toEqual(ROOT_ADMIN);
		await expect(bucketFor(host, undefined)).resolves.toEqual(ROOT_ADMIN);
	});

	it("uses shared for an undefined owner in an empty directory", async () => {
		const host = await fakeHost();

		await expect(bucketFor(host, undefined)).resolves.toEqual(SHARED);
	});

	it("shows non-admin and admin directory users only their own buckets", async () => {
		const host = await fakeHost({
			users: [
				{ user: "root-admin", admin: true },
				{ user: "alice", admin: false },
			],
		});

		await expect(bucketsVisibleTo(host, principal("alice"))).resolves.toEqual([
			ALICE,
		]);
		await expect(
			bucketsVisibleTo(host, principal("root-admin")),
		).resolves.toEqual([ROOT_ADMIN]);
	});

	it("shows an undefined principal shared in an empty directory", async () => {
		const host = await fakeHost();

		await expect(bucketsVisibleTo(host, principal(undefined))).resolves.toEqual([
			SHARED,
		]);
	});

	it("shows a ghost principal no buckets", async () => {
		const host = await fakeHost({
			users: [{ user: "alice", admin: false }],
		});

		await expect(bucketsVisibleTo(host, principal("ghost"))).resolves.toEqual([]);
	});

	it("enumerates every directory user plus shared", async () => {
		const host = await fakeHost({
			users: [
				{ user: "root-admin", admin: true },
				{ user: "alice", admin: false },
			],
		});

		await expect(allBuckets(host)).resolves.toEqual([ROOT_ADMIN, ALICE, SHARED]);
	});
});

describe("findVisible", () => {
	it("finds an item in the first supplied bucket containing its id", async () => {
		const host = await fakeHost();
		const store = new EscalationStore(host);
		const expected = item("wanted");
		await store.update(ALICE, (items) => ({
			items: [...items, item("other"), expected],
			result: undefined,
		}));

		await expect(findVisible(store, [SHARED, ALICE], "wanted")).resolves.toEqual({
			bucket: ALICE,
			item: expected,
		});
		await expect(findVisible(store, [SHARED], "wanted")).resolves.toBeUndefined();
		await expect(findVisible(store, [ALICE], "missing")).resolves.toBeUndefined();
	});
});
