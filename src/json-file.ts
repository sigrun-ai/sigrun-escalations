/**
 * A serialized, atomically replaced JSON file. The queue belongs to the
 * instance, so callers that share a file must also share its JsonFile.
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
	 * Read, transform, and conditionally write in one queue position.
	 * Returning the current value unchanged is a no-write fast path.
	 */
	update(transform: (current: T) => T | Promise<T>): Promise<T> {
		return this.enqueue(async () => {
			const current = await this.readNow();
			const next = await transform(current);
			if (next !== current) await this.writeNow(next);
			return next;
		});
	}

	private enqueue<R>(work: () => Promise<R>): Promise<R> {
		const next = this.queue.then(work, work);
		// A failed operation must not poison the queue; later work re-reads
		// the file rather than trusting state from the failed operation.
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
				// Preserve the original write failure if temp cleanup also fails.
			});
			throw error;
		}
	}
}
