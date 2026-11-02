import type { ExtensionNoticeInput, SigrunHost } from "@sigrun/sigrun/extension";
import type { Escalation } from "./types.js";

async function notify(
	host: SigrunHost,
	e: Escalation,
	kind: string,
	title: string,
): Promise<void> {
	const input: ExtensionNoticeInput = {
		user: e.owner,
		kind,
		title,
		body: e.body.slice(0, 200),
		target: { view: "inbox", params: { id: e.id } },
	};
	try {
		await host.notify(input);
	} catch (error) {
		console.warn(`escalations: ${kind} notification failed for ${e.id}`, error);
	}
}

export async function notifyRaised(host: SigrunHost, e: Escalation): Promise<void> {
	await notify(host, e, "escalation.raised", `Needs your decision: ${e.title}`);
}

export async function notifyReopened(host: SigrunHost, e: Escalation): Promise<void> {
	await notify(host, e, "escalation.reopened", `Back in your inbox: ${e.title}`);
}

export async function notifyOrphaned(host: SigrunHost, e: Escalation): Promise<void> {
	await notify(host, e, "escalation.orphaned", `Job deleted: ${e.title}`);
}
