import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SigrunHost, SigrunExtensionResult } from "@sigrun/sigrun/extension";
import type { MemoryEventApi, HandlerContext } from "@sigrun/sigrun/extension";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createEscalations from "../src/index.js";
import { dismiss, raise } from "../src/lifecycle.js";
import { EscalationStore } from "../src/store.js";
import type { Bucket, Escalation } from "../src/types.js";
import { createFakeHost, type FakeHost } from "./fake-host.js";

const wiring = vi.hoisted(() => ({
	stores: [] as unknown[],
	tools: [] as unknown[],
	dispatch: [] as unknown[],
	sweep: [] as unknown[],
	views: [] as unknown[],
}));

// Call through to every real collaborator, recording the dependency object the
// factory gives it. The identity test therefore checks the production wiring,
// rather than comparing mocked return values.
vi.mock("../src/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/store.js")>();
	return {
		...actual,
		EscalationStore: class extends actual.EscalationStore {
			constructor(host: SigrunHost) {
				super(host);
				wiring.stores.push(this);
			}
		},
	};
});
vi.mock("../src/tools.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/tools.js")>();
	return {
		...actual,
		createTools: (deps: Parameters<typeof actual.createTools>[0]) => {
			wiring.tools.push(deps);
			return actual.createTools(deps);
		},
	};
});
vi.mock("../src/dispatch.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/dispatch.js")>();
	return {
		...actual,
		createRunSettled: (deps: Parameters<typeof actual.createRunSettled>[0]) => {
			wiring.dispatch.push(deps);
			return actual.createRunSettled(deps);
		},
	};
});
vi.mock("../src/sweep.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/sweep.js")>();
	return {
		...actual,
		createSweepTask: (deps: Parameters<typeof actual.createSweepTask>[0]) => {
			wiring.sweep.push(deps);
			return actual.createSweepTask(deps);
		},
	};
});
vi.mock("../src/inbox.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/inbox.js")>();
	return {
		...actual,
		createInboxView: (deps: Parameters<typeof actual.createInboxView>[0]) => {
			wiring.views.push(deps);
			return actual.createInboxView(deps);
		},
	};
});

const ALICE: Bucket = { kind: "user", user: "alice" };
const NOW = new Date("2026-11-02T12:00:00.000Z");
const hosts: FakeHost[] = [];

async function rig(): Promise<{ host: FakeHost; result: SigrunExtensionResult }> {
	const host = await createFakeHost({
		users: [
			{ user: "alice", admin: false },
			{ user: "bob", admin: false },
		],
	});
	hosts.push(host);
	return { host, result: createEscalations(host) };
}

function item(id: string): Escalation {
	return {
		...raise(
			{
				owner: "alice",
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

async function seedAlice(store: EscalationStore): Promise<void> {
	await store.update(ALICE, (items) => ({
		items: [...items, item("first"), dismiss(item("second"), NOW)],
		result: undefined,
	}));
}

async function stored(host: FakeHost, user: string): Promise<Escalation[]> {
	const path = join(host.stores.user(user).paths.data, "escalations.json");
	return JSON.parse(await readFile(path, "utf8")) as Escalation[];
}

const unusedApi = {} as MemoryEventApi;
const unusedContext: HandlerContext = { abortSignal: undefined };

async function deleteUser(result: SigrunExtensionResult): Promise<void> {
	await result.userDeleted?.(
		{ user: "alice", transferTo: "bob" },
		unusedApi,
		unusedContext,
	);
}

it("userDeleted stamps the transfer history with the injected clock", async () => {
	const host = await createFakeHost({
		users: [
			{ user: "alice", admin: false },
			{ user: "bob", admin: false },
		],
	});
	hosts.push(host);
	const result = createEscalations(host, { now: () => NOW });
	const store = wiring.stores[0] as EscalationStore;
	await seedAlice(store);

	await deleteUser(result);

	for (const entry of await stored(host, "bob")) {
		expect(entry.history.at(-1)).toEqual({
			at: NOW.toISOString(),
			event: "transferred",
			note: "transferred from alice",
		});
	}
});

beforeEach(() => {
	for (const entries of Object.values(wiring)) entries.length = 0;
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(hosts.splice(0).map((host) => host.cleanup()));
});

describe("createEscalations", () => {
	it("declares the complete factory result and takes the host at arity one", () => {
		const result = createEscalations({} as SigrunHost);

		expect(createEscalations.length).toBe(1);
		expect(Object.keys(result).sort()).toEqual([
			"extension",
			"jobs",
			"publishedHooks",
			"runSettled",
			"surfaces",
			"userDeleted",
		]);
		expect(result.extension?.name).toBe("escalations");
		expect(result.extension?.tools?.map((tool) => tool.name)).toEqual([
			"escalate",
			"escalation_list",
			"escalation_resolve",
		]);
		expect(result.jobs).toEqual([
			{ name: "sweep", schedule: { every: "15m" }, action: { kind: "task", task: "escalations.sweep" } },
		]);
		expect(result.surfaces?.views?.map((view) => view.id)).toEqual(["inbox"]);
	});

	it("constructs one store and gives that same instance to every consumer", () => {
		const result = createEscalations({} as SigrunHost);

		expect(wiring.stores).toHaveLength(1);
		const store = wiring.stores[0];
		for (const deps of [
			...wiring.tools,
			...wiring.dispatch,
			...wiring.sweep,
			...wiring.views,
		]) {
			expect((deps as { store: unknown }).store).toBe(store);
		}
		// Immediate dispatch is called by the inbox with the view's own store;
		// createRunSettled is separately wired above with the same instance.
		expect(result.runSettled).toBeTypeOf("function");
	});

	it("transfers every item to the target owner without changing its status", async () => {
		const { host, result } = await rig();
		const store = wiring.stores[0] as EscalationStore;
		await seedAlice(store);

		await deleteUser(result);

		const transferred = await stored(host, "bob");
		expect(transferred.map((entry) => entry.id)).toEqual(["first", "second"]);
		expect(transferred.map((entry) => entry.status)).toEqual(["open", "dismissed"]);
		expect(transferred.every((entry) => entry.owner === "bob")).toBe(true);
		for (const entry of transferred) {
			expect(entry.history.at(-1)).toMatchObject({
				event: "transferred",
				note: "transferred from alice",
			});
		}
		expect(await stored(host, "alice")).toEqual([]);
	});

	it("recovers a failed source rewrite by deduplicating on the next transfer", async () => {
		const { host, result } = await rig();
		const store = wiring.stores[0] as EscalationStore;
		await seedAlice(store);
		const update = store.update.bind(store);
		vi.spyOn(store, "update").mockImplementation(async (bucket, fn) => {
			if (bucket.kind === "user" && bucket.user === "alice") {
				throw new Error("simulated crash before the source rewrite");
			}
			return await update(bucket, fn);
		});

		await expect(deleteUser(result)).rejects.toThrow("simulated crash");
		expect((await stored(host, "bob")).map((entry) => entry.id)).toEqual(["first", "second"]);
		expect((await stored(host, "alice")).map((entry) => entry.id)).toEqual(["first", "second"]);

		vi.restoreAllMocks();
		await deleteUser(result);

		const target = await stored(host, "bob");
		expect(target.map((entry) => entry.id)).toEqual(["first", "second"]);
		expect(target.every((entry) => entry.owner === "bob")).toBe(true);
		expect(await stored(host, "alice")).toEqual([]);
	});
});
