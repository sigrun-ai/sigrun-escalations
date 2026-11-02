/**
 * JsonFile<T> — one serialized, atomically replaced JSON state file.
 *
 * Updates run read → mutate → write in one queue position. Writes use a
 * same-directory temp file and rename, and are always mode 0600. Malformed
 * JSON throws naming the path rather than being silently reset.
 *
 * The queue is PER INSTANCE: users sharing a path must share the JsonFile.
 */
import { randomUUID } from "node:crypto";
import {
	chmod,
	mkdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export class JsonFile<T> {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly path: string,
		private readonly initial: () => T,
	) {}

	read(): Promise<T> {
		return this.enqueue(() => this.readNow());
	}

	/**
	 * Return the next state from the current one. Returning the same reference
	 * is a no-op: the read is serialized, but no replacement is written.
	 */
	update(mutate: (current: T) => T | Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const current = await this.readNow();
			const next = await mutate(current);
			if (next !== current) await this.writeNow(next);
			return next;
		});
	}

	private enqueue<R>(work: () => Promise<R>): Promise<R> {
		const next = this.queue.then(work, work);
		// A rejected operation does not poison later reads or updates.
		this.queue = next.catch(() => {});
		return next;
	}

	private async readNow(): Promise<T> {
		let text: string;
		try {
			text = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return this.initial();
			}
			throw error;
		}
		try {
			return JSON.parse(text) as T;
		} catch (error) {
			throw new Error(
				`escalations: malformed JSON in ${this.path}: ${String(error)}`,
				{ cause: error },
			);
		}
	}

	private async writeNow(value: T): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temp, `${JSON.stringify(value, null, "\t")}\n`, {
				mode: 0o600,
			});
			await chmod(temp, 0o600);
			await rename(temp, this.path);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {
				// Keep the original write failure if cleanup also fails.
			});
			throw error;
		}
	}
}
