import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PromptInput } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { escalationsSection } from "../src/section.js";

const TEXT = 'Escalations: when something needs the user\'s decision and has no prescribed way forward, call `escalate` instead of guessing. Make the body self-contained: the evidence, the exact action you propose, and the alternatives — whoever acts on the answer may not have this conversation. Offer the possible actions as options; never add "do nothing" or "later" options — the user has Dismiss and Snooze for those. In a scheduled job run, call `escalation_list` first: skip every key under `skip`, carry out each item under `act`, and call `escalation_resolve` for each before you finish.';

function input(toolNames: readonly string[]): PromptInput {
	return {
		agent: { tools: toolNames.map((name) => ({ name })) },
	} as unknown as PromptInput;
}

describe("escalations prompt section", () => {
	it("renders the exact guidance when escalate is offered", async () => {
		expect(escalationsSection.key).toBe("escalations");
		expect(
			escalationsSection.render(input(["bash", "escalate"]), BACKGROUND_CONTEXT),
		).toBe(TEXT);
	});

	it("renders nothing when escalate is not offered", async () => {
		expect(
			escalationsSection.render(
				input(["escalation_list", "escalation_resolve"]),
				BACKGROUND_CONTEXT,
			),
		).toBeUndefined();
	});
});
