# AGENTS.md — sigrun-ext-escalations

Guidance for coding agents working in this repository.

## What this is

The escalations extension for [sigrun](https://github.com/sigrun-ai/sigrun):
an asynchronous decision inbox for jobs and agents, with durable escalation
records, agent tools, and lifecycle transitions for answers, claims, snoozes,
dismissal, and resolution.

A sigrun extension (pi-durable loader contract): a default-export factory
taking the `SigrunHost`, returning a `SigrunExtensionResult` (types from
`@sigrun/sigrun/extension`, a types-only subpath — never a runtime import).

## Layout

- `src/index.ts` — the default-export factory: one shared `EscalationStore`
  wired to the tools, dispatch, sweep, Inbox, and at-least-once user transfer.
- `src/types.ts` — escalation records and shared lifecycle types.
- `src/lifecycle.ts` — pure escalation state transitions.
- `test/fake-host.ts` — the in-memory `SigrunHost` with scriptable
  conversations, users, jobs, and notifications (unit tests never boot core).
- `test/` — vitest suites.
- `dist/` — **committed build output** (git-source installs load
  `dist/index.js` with no build step). Rebuild with `npm run build` and
  commit whenever `src/` moves; a stale dist is ship-blocking.

## Run and test

```sh
npm install
npm test            # check-manifest + vitest
npm run typecheck   # tsc --noEmit
npm run build       # tsc -> dist/ (commit the result)
```

## Conventions

- **Commit dist**: tracked by design (see the `.gitignore` comment). If
  `git status` shows `dist/` changes after a build, those belong in the
  same commit as the source change.
- **Verification before completion**: `npm test` + `npm run typecheck` +
  `npm run build` with a clean `git status -- dist` before claiming done.
- Lifecycle transitions are pure: return a new record and never mutate the
  input. Every transition appends its history entry, except an `endSnooze`
  no-op. Invalid transitions throw `TransitionError` with a stable code.
- Never auto-answer an escalation. Snooze expiry only reopens an item; failed
  and interrupted claims return it to open with the answer cleared.
- Keep one `EscalationStore` per factory call. Its per-path serialization is
  required across tools, dispatch, sweep, and views. On `userDeleted`, append
  to the transfer target before removing from the source; retries deduplicate
  by id.
- Tests own their literals: synthetic users (`alice`, `bob`, `root-admin`),
  jobs (`nightly-check`), keys (`disk:/srv/a`), and hosts
  (`*.example.invalid`); no real tokens, personal job details, or private
  URLs in fixtures.
- Host modules (`@earendil-works/*`) are peerDependencies; development
  pins exact 1.4.0 devDependencies. The `dependencies` field stays empty.
- Local `@sigrun/*` development links are not committed.
