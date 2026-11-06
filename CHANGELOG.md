# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-11-06

### Changed

- The Inbox is one split page: the tab's list in the sidebar (tabs stay
  in the header), the selected escalation in main, with its actions on
  a header callout and a `Viewing` badge on the row being read. Params
  are `{tab?, id}`: an id with no tab lists the item's own tab (notice
  and tool links), opening a row keeps the current tab, and compact
  widths use the page selection drill-in (list first, back to the tab).
  An unknown or invisible id keeps the caller's list and shows "not
  found" in main (identical for both — no title leak).

## [0.2.0] - 2026-11-05

### Added

- Published hooks `escalation.raise`, `escalation.take` and
  `escalation.resolve`: the extension-to-extension seam over the same
  store and lifecycle as the `escalate` tool. `take` claims an ANSWERED
  item for the calling conversation (idempotent per conversation,
  caller's bucket only); `resolve` needs the claiming conversation
  (wrong_claimant propagates). The warden is the first consumer
  (one-shot job grants).

## [0.1.1] - 2026-11-03
### Fixed
- `reopenReason` is cleared on forward transitions (`resolve` done,
  `dismiss`, `restore`) so a stale reopen badge no longer survives onto
  resolved or dismissed items.
- The seeded run text renders a deleted job's source as its bare id
  (`job "api:1"`) instead of the redundant `job "api:1" (api:1)`.
- Bulk inbox toasts pluralize (`Dismissed 2 escalations`, not the
  invented `escalation(s)` form).
- The findVisible-then-update race in inbox actions throws a typed
  `TransitionError` (`not_found`) and renders the same not-found body as
  an unknown id.
- The 15-minute sweep dedupes `jobs.get` lookups across buckets, stops
  cooperatively between buckets when the task's abort signal fires, and
  signals `changedInbox` for migrated items.
- `transferItems` no-ops on a same-bucket call and returns the moved
  ids.
- `userDeleted` transfer history is stamped with the injected clock.

### Changed
- The factory accepts an optional `{ now }` clock for tests (arity one
  is preserved for the loader).

## [0.1.0] - 2026-11-02

### Added
- The escalation extension factory with `escalate`, `escalation_list`, and
  `escalation_resolve` tools, prompt guidance, a four-tab Inbox, immediate
  and next-run dispatch, and a 15-minute maintenance sweep.
- Durable per-user escalation records with answer, claim, snooze, dismiss,
  restore, failure recovery, and resolved-item retention lifecycles.
- At-least-once escalation transfer when a directory user is deleted.
