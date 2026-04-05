---
enabled: true
current: 1.1.1
---

# Version History

## 1.1.1 — 2026-04-04
Fix email whitelist Reply-To bypass: `replyToEmail` and `replyToSharedEmail` now validate the effective reply destination (Reply-To if present, else From) against `EMAIL_WHITELIST`. Previously only `From` was checked in `replyToEmail`, and `replyToSharedEmail` had no whitelist check at all. Also: README/QUICKSTART cleanup, dependency unpinning, removed stale reference doc.

## 1.1.0 — 2026-04-04
SSH-friendly CLI: non-interactive dispatch mode, `doctor` health checks, `config get/set <KEY>` with secret allowlist, `logs --tail N [--follow]`, reliable exit codes on status/doctor/config, version in CLI banner. Interactive REPL unchanged.

## 1.0.0 — 2026-04-03
First production release. 26 bridge tools across calendar, tasks, people, files, email, and shared mailboxes. Autonomous Day 0 onboarding via bootstrap. Orphan turn adoption for cron and system-event turns. Cross-platform setup scripts (Windows + macOS/Linux).

## Planned

- **1.2.0** — Bespoke timeout handling & progressive ack (minor, new capability — activity-based idle timeout, exponential backoff status messages, full OpenClaw event stream handling)
- **1.3.0** — CHANNEL_MANAGER UPN resolution (minor, admin UX improvement)
- **1.4.0** — Code review refactors (minor — extract runToolLoop, queue factory, shared logging, prune stale maps)
- **1.5.0** — Windows service installer (minor, deployment — may be superseded depending on SSH CLI adoption)
- **1.6.0** — Patchnet Agent Support skill integration (minor, deployment)
- **2.0.0** — MCP migration (major, replaces bridge-tool code fence convention with proper MCP tool registration)

---

_See `C:\Dev\Version-Master.md` for the org-wide versioning rules and commit flow._
_See `CHANGELOG.md` in this repo for detailed per-release change history._
