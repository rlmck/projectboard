# Token audit (10 Nov 2026)

Ross was running out of tokens after 2–3 medium features. This is what a session cost before any work started, what was changed, and what's left as bigger ideas. Sizes are bytes on disk; tokens are estimated at about 4 bytes per token for this kind of Markdown.

## Why it matters more than the raw numbers suggest

Everything read into a session stays in its context, and **every later turn re-sends the whole context** (cached, so cheaper, but it still counts against usage). A file read once at `/start` is paid for again on every tool call for the rest of the session. A 40-turn feature with 60k tokens of up-front reading spends ~2.4M tokens just carrying that reading around. So the biggest wins are: read less up front, and use fewer turns.

## What a session loaded before doing any work (measured)

| Loaded | When | Size | ≈ tokens |
|---|---|---|---|
| `CLAUDE.md` | automatically, every session | 31.8 KB | 8,000 |
| Memory index (`MEMORY.md`, outside the repo) | automatically, every session | 10.1 KB (with mis-encoded dashes, which cost extra) | 3,000 |
| `CLAUDE.md` **again** | `/start` step 3 read it a second time | 31.8 KB | 8,000 |
| `PROJECT_STATUS.md` | `/start` | 15.3 KB | 3,800 |
| `TODO.md` | `/start` | 5.9 KB | 1,500 |
| `docs/codebase-overview.md`, **whole** | `/start` and working rule 1 | 130.8 KB | 33,000 |
| **Every session, total** | | **~226 KB** | **~57,000** |
| `docs/cast-contract.md`, whole | `/start`, for casting/Pi work | 52.7 KB | 13,000 |
| `pi/README.md`, whole | `/start`, for Pi work | 31.8 KB | 8,000 |
| **A Pi or casting session** | | **~310 KB** | **~78,000** |

Other costs found:
- **Deploy polling.** `/ship`, `/staging` and `/rollback` polled the live `sw.js` with a curl every 30 s for up to 10 minutes. Each poll was a separate turn, re-sending the whole context: a typical app ship took 4–8 extra turns, ~0.5M tokens at a 100k context.
- **Duplicated rules.** `PROJECT_STATUS.md` → Decisions repeated CLAUDE.md (the deploy policy, end to end, the feet rule, who cast, the MCP rule), and the memory index repeated CLAUDE.md again.
- **Session log entries** of ~1 KB each, five kept in the always-read status file (4.5 KB), each restating what the commit message and docs already say.
- **Tests and score tools** run when nothing they cover changed (several log entries run the Pi and console suites for app-only changes), and Chrome checks done by screenshot (each image costs more than a page-text or JS check).
- `docs/log/*.md` (55 KB and 19 KB) were read whole by `/wrap` just to add entries at the top.

Nothing bad was found in the hooks or build: the pre-commit scan and `bash build.sh --check` are fast (about 1 s) and print one line, so they cost almost nothing and stay exactly as they were.

## What changed (this commit)

| Change | Where | Saving |
|---|---|---|
| `/start` no longer re-reads CLAUDE.md (it's already loaded; only a pull's diff if it changed) | `.claude/commands/start.md` | ~8,000 tokens every session |
| The overview, cast contract and Pi README are read **by section** after the feature is known (`grep -n '^##'` for the map, then Read with offset/limit), not whole at start | `start.md`, CLAUDE.md working rule 1, a note at the top of each of the three docs | ~25,000–45,000 tokens a session (a typical feature needs 2–4 sections, ~8–15 KB) |
| `tools/wait-live.sh`: waits for a deploy's CACHE inside **one** command (15 s polls, 10 min cap, exits early if the site can't be reached) | new; `/ship`, `/staging`, `/rollback` | 4–8 turns per app ship → 1 (~0.3–0.7M tokens per ship at a 100k context) |
| Status file: 3 newest session entries (not 5), entries under 800 bytes, Decisions point to CLAUDE.md instead of repeating it; cap 12 KB (was 15) | `PROJECT_STATUS.md`, `/wrap`, CLAUDE.md session rules | 15.3 → 12.2 KB now (~800 tokens), more as new entries stay short |
| `/wrap` inserts into `docs/log/` without reading it whole | `.claude/commands/wrap.md` | ~5,000–14,000 tokens per wrap |
| CLAUDE.md: "Other tracked files" list cut to the rules it carried (the full map is overview §3); new working-rule-1 lines on reading by section, screenshots and running only the related tests | CLAUDE.md | about neutral in size; saves turns |
| Memory index rewritten: short hooks, mis-encoding fixed, superseded entries on one History line (every memory file kept) | `MEMORY.md` (outside the repo) | 10.1 → 4.2 KB, ~1,800 tokens every session |

**Before → after, before any work:** ~57,000 tokens → ~20,000 for a typical app session (CLAUDE.md 8k + memory 1k + status 3k + TODO 1.5k + 2–4 overview sections ~3k + the map ~0.5k). A Pi session: ~78,000 → ~25,000. Carried across a 40-turn session that's roughly 1.5–2M fewer tokens, plus the deploy polling turns saved on every ship.

**Safety gates untouched:** `build.sh --check` (the deploy gate), the pre-commit secret scan, the Pi busy check in `/pi-deploy`, the migration dry run in working rule 2, the gated actions list. No rule or data trap was removed from CLAUDE.md.

**Applied later by Ross:** `"Bash(bash tools/wait-live.sh*)"` is in the allow list in `.claude/settings.json`. The stale 11-script syntax-check allow rule is removed in the replacement file from review fix session 3 (14 Nov 2026, BLD-07; Ross saves it, since Claude Code never edits its own permission file): `Bash(bash build.sh*)` already runs the same check over all 14 scripts.

## Bigger ideas, not applied

1. **Split CLAUDE.md by area (~32 KB on every turn).** Claude Code also loads a `CLAUDE.md` found in a subfolder, but only when it works on files there. The Pi rules (cast contract summary, LED traps) could move to `pi/CLAUDE.md`, the console's to `console/CLAUDE.md`, and the board-data traps to `app/CLAUDE.md`, leaving ~12–15 KB of core rules at the root. Saves ~4,000–5,000 tokens on every turn of a session that doesn't touch that area. Not done because these are safety rules and the claude.ai chat reads only the root file: Ross's call.
2. **Split `docs/codebase-overview.md` into per-area files** (`docs/overview/data-model.md`, `wall.md`, `board-setup.md`…). Section reads already get most of the saving; a split would make it automatic and stop accidental whole-file reads.
3. **`/clear` between features.** One feature per session is already the rule; starting a fresh session (or `/clear`) for the next feature instead of carrying the last one's context is the single biggest habit change. `/compact` mid-feature helps when a session gets long.
4. **Cheaper model for routine work.** Docs edits, TODO changes, `/wrap` and simple fixes don't need the largest model; `/model` to Sonnet for those, or a lower effort setting, stretches the allowance.
5. **Explore subagent for wide searches.** A broad hunt across many files can run in a subagent so only its conclusion enters the main context (a subagent starts cold, so only worth it for searches that would otherwise read a lot).
6. **Trim the session-log habit further:** the commit message could be the log, with the status file keeping only Current state, Waiting on and the last entry.
