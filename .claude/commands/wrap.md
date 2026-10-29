---
description: Wrap up a session - session log entry and status updates in PROJECT_STATUS.md, then ship them
---
End of session (CLAUDE.md → Session rules).

1. `git fetch origin` and `git pull --ff-only` first: the claude.ai chat may have edited `PROJECT_STATUS.md` on `main`.
2. In `PROJECT_STATUS.md`:
   - Add a **Session log** entry at the top: `- **YYYY-MM-DD, Claude Code (topic).**` then short sub-bullets: **Changed** (with the CACHE stamp if `app/` shipped), **Tested**, **Live** (what was pushed, the CACHE seen), **Left**, **New questions**. Aim for under 1 KB.
   - Keep only the **5 newest** entries. Move older ones, word for word, to the top of the month's file in `docs/log/` (`docs/log/YYYY-MM.md`, newest first; start a new month's file with the same heading style when needed).
   - Update **Current state**, **Decisions**, **Next** (renumbered in priority order), **Waiting on**, **Open questions** and **Backlog** for anything that changed; strike or remove what's done.
   - Keep the file under 15 KB (`wc -c PROJECT_STATUS.md`). Nothing personal about users, nothing secret, nothing copied from `docs/security-findings.md`, no live row data.
3. Update `CLAUDE.md` or `docs/codebase-overview.md` only if a rule, trap or the architecture changed.
4. Ship the docs as `/ship` does (they change no shipped file, so the CACHE stays) and tell Ross what's left for next time.

$ARGUMENTS
