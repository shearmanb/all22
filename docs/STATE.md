# All22 Session State

_Last updated: 2026-07-07 (end of session)_

## Where things stand — LIVE
The PRD rebuild is **deployed to production** (Railway auto-deploys `main`).
`main` and the working branch `claude/fantasy-pros-redesign-082rjd` are in sync
except for a docs-only commit on the branch (this file, CLAUDE.md, TODO.md).
Migrations applied in prod: 001–014.

- **Combine** (`/combine.html`) — screenshot→Claude-vision OCR (owner tested in
  prod: WORKS; `ANTHROPIC_API_KEY` is set on Railway), paste-as-text, and
  CSV/spreadsheet import (auto-detects columns incl. auction $). Review queue,
  set compare, exports incl. Underdog-with-IDs. Optional per-row auction values
  (migration 013) shown/exported only when a set has them.
- **Big Board** (`/boards.html`, migration 014) — hand-built drag-and-drop
  lists (built for the owner's Zero RB list), search-to-add via players_master,
  pointer drag + ▲▼ reorder. Independent of ingested rankings.
- **Playbook** — the renamed pre-rebuild draft tracker, unchanged data.
- **Notes**, **hub** (launcher + data-health + league settings + news) — live.
- **players_master** seeds/refreshes from Sleeper daily; manual adds + per-site
  learned aliases live on the row.

## Decisions made this session (don't relitigate)
- **Railway + Express + Railway Postgres stays.** Supabase was evaluated at the
  owner's request and rejected: free tier pauses after ~1 week idle (deadly for
  a seasonal app), cross-provider query latency, and its headline features
  (auto REST API) are redundant with the Express backend. Revisit only if a
  specific need appears (its table-editor UI was the one attraction — a
  read-only data browser in the hub is the cheaper answer).
- **OCR model dial** defaults to `claude-sonnet-5` (Combine → Settings). Owner
  has the model-choice framework: smallest accurate model for runtime calls;
  biggest model for silent-corruption-risk work (Phase 2 math → Fable-class).
- **Zero RB shipped as general custom lists** (Big Board applet), not a
  hardcoded single list.

## Bug fixed this session
One-click ingest was dropping `auction_value` on save (client payload omitted
it; only direct API posts kept it). Fixed in `combine.html` payloadRows.

## Immediate next steps
1. Owner has more issues from testing — only auction values, Zero RB, and CSV
   import were named and all three are shipped. Get the rest of the list.
2. Owner to decide on native .xlsx upload (needs SheetJS dependency approval).
3. One-time: re-match legacy sets; confirm `COOKIE_SECRET` on Railway.
4. Before Phase 2 (custom model): the dedicated deep session on blending math —
   see `docs/SESSION_PLAN.md` open decisions. Do not quick-pick defaults.

TODO.md carries the full follow-up list. 50 tests green at session end.
