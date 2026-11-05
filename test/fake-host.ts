import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationId, SubmissionId } from "@earendil-works/pi-durable";
import type {
	HostJobInfo,
	Principal,
	SigrunHost,
} from "@sigrun/sigrun/extension";
import type {
	SubmissionRecordWire,
	UserWire as DirectoryUserWire,
} from "@sigrun/shared/views";
import type { SessionMeta } from "@sigrun/shared/session-meta";

export interface FakeCall {
	readonly method: string;
	readonly args: readonly unknown[];
}

export interface FakeHostOptions {
	readonly users?: readonly { user: string; admin: boolean }[];
	readonly jobs?: Record<string, HostJobInfo>;
}

export interface FakeHost extends SigrunHost {
	readonly calls: readonly FakeCall[];
	setMeta(conversationId: ConversationId, meta: SessionMeta): void;
	setJob(id: string, info: HostJobInfo | undefined): void;
	cleanup(): Promise<void>;
}

/**
 * An in-memory host for extension tests. Store paths point at a real temp
 * directory; the host members the escalation extension uses are functional
 * and every other member rejects explicitly rather than hiding a test gap.
 */
export async function createFakeHost(
	opts: FakeHostOptions = {},
): Promise<FakeHost> {
	const root = await mkdtemp(join(tmpdir(), "sigrun-escalations-fake-host-"));
	const calls: FakeCall[] = [];
	const record = (method: string, ...args: readonly unknown[]): void => {
		calls.push({ method, args });
	};
	const notUsed = (): (() => never) => {
		return () => {
			throw new Error("not used in escalations tests");
		};
	};

	const users = new Map<string, DirectoryUserWire>(
		(opts.users ?? []).map((entry) => [
			entry.user,
			{
				user: entry.user,
				admin: entry.admin,
				createdAt: 0,
				source: "cli" as const,
			},
		]),
	);
	const jobs = new Map<string, HostJobInfo>(Object.entries(opts.jobs ?? {}));
	const metas = new Map<ConversationId, SessionMeta>();
	const submissions = new Map<ConversationId, SubmissionRecordWire[]>();
	let nextConversationId = 1;
	let nextSubmissionId = 1;

	const emptyMeta = (): SessionMeta => ({
		pinned: false,
		tagged: [],
		archived: false,
		draft: { text: "", attachments: [] },
		source: "test",
	});

	const conversations: SigrunHost["conversations"] = {
		create: async (input) => {
			record("conversations.create", input);
			const id = nextConversationId++ as ConversationId;
			metas.set(id, {
				...emptyMeta(),
				...(input.owner === undefined ? {} : { owner: input.owner }),
				...(input.name === undefined ? {} : { name: input.name }),
				...(input.source === undefined ? {} : { source: input.source }),
				...(input.job === undefined ? {} : { jobId: input.job }),
			});
			submissions.set(id, []);
			return id;
		},
		submit: async (id, input, submitOpts) => {
			record("conversations.submit", id, input, submitOpts);
			const submission: SubmissionRecordWire = {
				id: nextSubmissionId++ as SubmissionId,
				conversationId: id,
				...(submitOpts?.requestId === undefined
					? {}
					: { requestId: submitOpts.requestId }),
				type: "pi.user",
				status: "queued",
			};
			const existing = submissions.get(id) ?? [];
			existing.push(submission);
			submissions.set(id, existing);
			return submission;
		},
		meta: async (id) => {
			record("conversations.meta", id);
			return metas.get(id) ?? emptyMeta();
		},
		entries: async (id, query, limit, cursor) => {
			record("conversations.entries", id, query, limit, cursor);
			// Recording stub: tests that need entries pass their own host.
			return { items: [] };
		},
		entry: async (id, entryId) => {
			record("conversations.entry", id, entryId);
			return undefined;
		},
		watch: notUsed(),
		list: notUsed(),
		abort: notUsed(),
		configure: notUsed(),
		compact: notUsed(),
		fork: notUsed(),
		patchMeta: notUsed(),
		upload: notUsed(),
		readFile: notUsed(),
	};

	const host: SigrunHost = {
		stores: {
			user: (user) => ({
				secrets: {
					get: notUsed(),
					set: notUsed(),
					delete: notUsed(),
				},
				settings: {
					get: notUsed(),
					set: notUsed(),
				},
				paths: {
					data: join(root, "data", "users", user),
					state: join(root, "state", "users", user),
					cache: join(root, "cache", "users", user),
				},
			}),
			secrets: {
				get: notUsed(),
				set: notUsed(),
			},
			settings: {
				get: notUsed(),
				set: notUsed(),
			},
			paths: {
				data: join(root, "data"),
				state: join(root, "state"),
				cache: join(root, "cache"),
			},
		},
		tools: { setUserTools: notUsed() },
		services: { connect: notUsed() },
		seedInteraction: notUsed(),
		answerInteraction: notUsed(),
		settleInteraction: notUsed(),
		declineInteraction: notUsed(),
		peekInteraction: notUsed(),
		snapshotInteraction: notUsed(),
		setAmbient: notUsed(),
		clearAmbient: notUsed(),
		conversations,
		jobs: {
			get: async (id) => {
				record("jobs.get", id);
				return jobs.get(id);
			},
			activeRun: notUsed(),
			isJobRun: notUsed(),
		},
		notify: async (input) => {
			record("notify", input);
		},
		users: {
			list: async () => {
				record("users.list");
				return [...users.values()];
			},
			get: async (user) => {
				record("users.get", user);
				return users.get(user);
			},
		},
		accounts: {
			lookup: notUsed(),
			link: notUsed(),
			unlink: notUsed(),
			listForUser: notUsed(),
		},
		access: { accessOf: notUsed() },
		identity: {
			actingUser: async (id) => {
				record("identity.actingUser", id);
				return metas.get(id)?.owner;
			},
		},
		surfaces: {
			changed: (id, key, update) => {
				record("surfaces.changed", id, key, update);
			},
		},
		notices: {
			post: notUsed(),
			clear: notUsed(),
			list: notUsed(),
		},
		decisions: {
			evaluate: notUsed(),
			list: notUsed(),
		},
		publishedHooks: {
			get: notUsed(),
			call: notUsed(),
		},
		models: { list: notUsed(), complete: notUsed() },
		commands: {
			list: notUsed(),
			run: notUsed(),
		},
		// The curator lane's host surface (core 0.5.0): escalations never
		// touches it — every member stays in the not-used family.
		curation: new Proxy(
			{} as SigrunHost["curation"],
			{
				get: () => {
					throw new Error("not used in escalations tests");
				},
			},
		),
	};

	return {
		...host,
		calls,
		setMeta: (id, meta) => {
			metas.set(id, meta);
		},
		setJob: (id, info) => {
			if (info === undefined) jobs.delete(id);
			else jobs.set(id, info);
		},
		cleanup: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

// Keep these contract types visible at the fixture's import site for suites
// that construct principal or job values alongside the fake host.
export type { HostJobInfo, Principal, SessionMeta };
