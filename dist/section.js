import { section } from "@earendil-works/pi-durable";
export const ESCALATIONS_SECTION_TEXT = "Escalations: when something needs the user's decision and has no prescribed way forward, call `escalate` instead of guessing. Make the body self-contained: the evidence, the exact action you propose, and the alternatives — whoever acts on the answer may not have this conversation. Offer the possible actions as options; never add \"do nothing\" or \"later\" options — the user has Dismiss and Snooze for those. In a scheduled job run, call `escalation_list` first: skip every key under `skip`, carry out each item under `act`, and call `escalation_resolve` for each before you finish.";
export const escalationsSection = section("escalations", (input) => input.agent.tools.some((tool) => tool.name === "escalate")
    ? ESCALATIONS_SECTION_TEXT
    : undefined);
