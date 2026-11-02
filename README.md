# @sigrun/ext-escalations

An asynchronous decision inbox for [sigrun](https://github.com/sigrun-ai/sigrun). Jobs and agents can ask a person to choose a course of action without pausing the work that raised the question. Escalations are durable records with a complete history; they live in their own **Inbox** pane rather than blocking a conversation.

Unlike a mid-conversation question, an escalation does not suspend its source. A scheduled run can finish and deal with the decision on a later run, and an agent can hand the answered decision to a fresh run. Both surfaces use the same choice-and-instruction vocabulary, but only a person answers, dismisses, or snoozes an escalation.

## Requirements and installation

This extension requires **sigrun core with job hooks (unreleased at the time of writing)** — the first release carrying `host.notify`, `host.jobs` and `conversations.create({job})`.

Add `@sigrun/ext-escalations` to the `extensions` list in sigrun's settings. The extension contributes the three agent tools, the Inbox view, and a maintenance job that runs every 15 minutes.

## Agent tools

### `escalate`

Raises a decision for the conversation owner. Parameters:

- `key` (string, required): a stable identifier for the underlying issue, such as a resource key.
- `title` (string, required): a short summary.
- `body` (string, required): self-contained evidence, context, and the proposed action.
- `options` (array, required): one to eight choices. Each has a stable `id`, a `label`, and an optional `detail`. Do not offer “do nothing” or “later” choices; the person already has Dismiss and Snooze.
- `allowInstruction` (boolean, optional): whether the answer may include a free-text instruction. Defaults to `true`.
- `onAnswer` (`"next-run"` or `"immediate"`, optional): how to act after the answer. See below.

An unresolved item with the same key in the same job or user namespace is returned instead of duplicated. Raising a new item notifies its owner.

### `escalation_list`

Takes no parameters and returns two groups:

- **`skip`**: keys the current job must not act on because a matching escalation is open, answered, claimed, dismissed, or snoozed and is not held by this conversation. A dismissed or snoozed issue therefore stays out of the job's way until the person restores it or the snooze ends.
- **`act`**: answered `next-run` items whose work this conversation should carry out, including the chosen option and any instruction.

A scheduled (`cron`) run atomically claims its actionable items when it lists them. Other callers only see claims they already hold. After carrying out each claimed item, the run must resolve it.

### `escalation_resolve`

Resolves one item claimed by the current conversation:

- `id` (string, required): the escalation id.
- `outcome` (`"done"` or `"failed"`, required): whether the requested action succeeded.
- `note` (string, required): a short outcome record for the history.

`done` moves the item to **Resolved**. `failed` returns it to **Open**, clears its answer and claim, and records that the action failed. Only the claiming conversation may resolve the item.

## Next-run versus immediate dispatch

For a job conversation, the default is **`next-run`**: the answer waits until a later scheduled run, when `escalation_list` claims it for action. `next-run` is valid only for an item raised by a scheduled job.

For an ordinary agent conversation, the default is **`immediate`**: answering starts a fresh run in a **new conversation**, seeded with the escalation and the answer. It does not resume or modify the source conversation. An immediate item from a job also starts a fresh run. If the new run cannot be created or seeded, the item returns to open; if it settles without resolving its claim, the item is released back to open.

## The Inbox

The Inbox has four tabs:

- **Open**: unanswered decisions, including items returned by failed or interrupted actions.
- **In progress**: answered, claimed, and snoozed items.
- **Dismissed**: items the person has set aside. Restore moves one back to open.
- **Resolved**: completed items, retained for 90 days after resolution.

An open item can be answered by selecting an offered option and, when allowed, adding an instruction. **Dismiss** and **Snooze** are user-only actions, never agent options. A snooze lasts from 1 to 365 days; when it ends, the maintenance job returns the item to open. Nothing automatically answers an escalation or acts merely because a snooze expired.

The maintenance sweep also releases claims older than 24 hours, marks items whose source job was deleted, and prunes old resolved records. An orphaned item offers only Dismiss; nothing acts on it automatically.
