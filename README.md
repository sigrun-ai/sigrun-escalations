# @sigrun/escalations

An asynchronous decision inbox for [sigrun](https://github.com/sigrun-ai/sigrun). Jobs and agents can ask a person to choose a course of action without pausing the work that raised the question. Escalations are durable records with a complete history; they live in their own **Inbox** pane rather than blocking a conversation.

Unlike a mid-conversation question, an escalation does not suspend its source. A scheduled run can finish and deal with the decision on a later run, and an agent can hand the answered decision to a fresh run. Both surfaces use the same choice-and-instruction vocabulary, but only a person answers, dismisses, or snoozes an escalation.

## Requirements and installation

This extension requires **sigrun core with job hooks (unreleased at the time of writing)** — the first release carrying `host.notify`, `host.jobs` and `conversations.create({job})`.

Add `@sigrun/escalations` to the `extensions` list in sigrun's settings. The extension contributes the three agent tools, the Inbox view, and a maintenance job that runs every 15 minutes.

## Agent tools

### `escalate`

Raises a decision for the conversation owner. Parameters:

- `key` (string, required): a stable identifier for the underlying issue, such as a resource key.
- `title` (string, required): a short summary.
- `body` (string, required): self-contained evidence, context, and the proposed action.
- `options` (array, required): one to eight choices. Each has a stable `id`, a `label`, an optional `detail`, and optional `calls`: up to 16 `{ tool, arguments }` entries naming the exact tool calls the option authorizes. The Inbox shows each call under its option, and the claiming run sees the chosen option's calls in `escalation_list`. Do not offer “do nothing” or “later” choices; the person already has Dismiss and Snooze.
- `allowInstruction` (boolean, optional): whether the answer may include a free-text instruction. Defaults to `true`.
- `onAnswer` (`"next-run"` or `"immediate"`, optional): how to act after the answer. See below.

An unresolved item with the same key in the same job or user namespace is returned instead of duplicated. Raising a new item notifies its owner.

### `escalation_list`

Takes no parameters and returns two groups:

- **`skip`**: keys the current job must not act on because a matching escalation is open, answered, claimed, dismissed, or snoozed and is not held by this conversation. A dismissed or snoozed issue therefore stays out of the job's way until the person restores it or the snooze ends.
- **`act`**: answered `next-run` items whose work this conversation should carry out, including the chosen option, any instruction, and the chosen option's approved calls.

A scheduled (`cron`) run atomically claims its actionable items when it lists them. Other callers only see claims they already hold. After carrying out each claimed item, the run must resolve it. A run that ends without resolving a claimed `next-run` item returns it to answered with the answer kept, so the job's next run claims it again.

### `escalation_resolve`

Resolves one item claimed by the current conversation:

- `id` (string, required): the escalation id.
- `outcome` (`"done"` or `"failed"`, required): whether the requested action succeeded.
- `note` (string, required): a short outcome record for the history.

`done` moves the item to **Resolved**. `failed` returns it to **Open**, clears its answer and claim, and records that the action failed. Only the claiming conversation may resolve the item.

## Published hooks

The extension publishes four hooks for other extensions through core's published-hook registry (`host.publishedHooks`). All four require a call context with a `conversationId`; without one the call fails with `escalation hooks need a conversation`.

The namespace is `job:<jobId>` when the payload passes a `jobId`, else the calling conversation's `meta.jobId`, else `"user"`. The bucket comes from the calling conversation's owner, exactly as the agent tools do. All writes go through the store's serialized `update`.

### `escalation.raise`

Input: `{ key, title, body, options, allowInstruction?, onAnswer?, jobId? }` with the same bounds as the `escalate` tool (`key` and `title` ≤ 200 chars, `body` ≤ 20000, 1–8 options with unique ids). Output: `{ id, created, status }`.

Behavior mirrors `escalate`: an unresolved item with the same namespace and key is returned with `created: false` instead of duplicating; a new item notifies its owner. `onAnswer` defaults to `next-run` in a job namespace and `immediate` otherwise; `next-run` without any job context throws. `allowInstruction` defaults to `false`.

### `escalation.take`

Input: `{ key, jobId? }`. Output: `{ status, id?, option? }`.

Finds the unresolved item with the given namespace and key. When none exists, returns `{ status: "none" }`. An **answered** item is claimed for the calling conversation, returning `{ status: "claimed", id, option }` with the answer's option. The take is idempotent for the claiming conversation; another conversation (or an **open** item) gets the item's current status without claiming anything.

### `escalation.resolve`

Input: `{ id, outcome: "done" | "failed", note? }` (`note` defaults to `""`). Output: `{ status }`.

Finds the item by id and resolves it through the claiming conversation. Only the claiming conversation may resolve; a wrong claimant or an unclaimed item fails with the lifecycle transition code (`wrong_claimant` / `not_claimed`) as the error message.

### `escalation.approved-calls`

Input: `{ jobId? }`. Output: `{ calls: [{ id, tool, arguments }] }`.

Lists the calls declared by the chosen option of every item in the namespace that the calling conversation has claimed (`id` is the item's id). Items without a chosen option, or whose chosen option declares no calls, contribute nothing. The warden uses this to let a run make exactly the calls a person approved. Escalations stores and shows the calls but never interprets them.

## Next-run versus immediate dispatch

For a job conversation, the default is **`next-run`**: the answer waits until a later scheduled run, when `escalation_list` claims it for action. `next-run` is valid only for an item raised by a scheduled job.

For an ordinary agent conversation, the default is **`immediate`**: answering starts a fresh run in a **new conversation**, seeded with the escalation and the answer. It does not resume or modify the source conversation. An immediate item from a job also starts a fresh run. If the new run cannot be created or seeded, the item returns to open; if it settles without resolving its claim, the item is released back to open. A `next-run` item whose claiming run settles unresolved keeps its answer and returns to answered for the next run.

## The Inbox

The Inbox has four tabs:

- **Open**: unanswered decisions, including items returned by failed or interrupted actions.
- **In progress**: answered, claimed, and snoozed items.
- **Dismissed**: items the person has set aside. Restore moves one back to open.
- **Resolved**: completed items, retained for 90 days after resolution.

An open item can be answered by selecting an offered option and, when allowed, adding an instruction. **Dismiss** and **Snooze** are user-only actions, never agent options. A snooze lasts from 1 to 365 days; when it ends, the maintenance job returns the item to open. Nothing automatically answers an escalation or acts merely because a snooze expired.

The maintenance sweep also releases claims older than 24 hours (a `next-run` item keeps its answer), marks items whose source job was deleted, and prunes old resolved records. An orphaned item offers only Dismiss; nothing acts on it automatically.
