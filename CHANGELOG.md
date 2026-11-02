# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- The escalation extension factory with `escalate`, `escalation_list`, and
  `escalation_resolve` tools, prompt guidance, a four-tab Inbox, immediate
  and next-run dispatch, and a 15-minute maintenance sweep.
- Durable per-user escalation records with answer, claim, snooze, dismiss,
  restore, failure recovery, and resolved-item retention lifecycles.
- At-least-once escalation transfer when a directory user is deleted.
