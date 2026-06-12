# All22 Kickoff Prompt

Paste everything below into a fresh Claude Code session in this repo.

---

Read CLAUDE.md first — it defines the stack, file layout, and hard rules. This prompt covers what to build and in what order. Build Phase 1 only, then stop for my checkpoint test (see docs/SESSION_PLAN.md for all phases).

## Context

All22 is a fantasy football web portal for exactly one user (me). It runs as a Node.js/Express app on Railway with Railway Postgres, deployed by pushing to `main`. The repo is currently empty except for CLAUDE.md and docs/. Nothing exists yet to regress — but once a phase passes its checkpoint, everything in it is load-bearing and must not break in later phases.

## Spec

### Feature 1 — Draft Tracker (Phases 1–3)

**Logging drafts:**
- A "New Draft" page with a large textarea. I paste the raw draft-board/results text copied from a draft site (Underdog first; the parser lives in `lib/parsers/underdog.js` with a registry so other sites can be added later as separate files).
- Clicking "Parse" shows a preview table of every detected pick (overall pick #, round, player name, position, NFL team, drafting slot) BEFORE saving. Unparseable lines appear in a visible "couldn't parse" list — never silently dropped. I can edit any cell in the preview and add missed picks manually.
- Saving requires: site (select: Underdog / Yahoo / Sleeper / Other), draft type (Mock / Best Ball / Season League), date (defaults to today), league size, my draft slot. Optional: strategy tag, my 1–5 star rating, notes.
- Strategy tag is a select with at minimum: Hero RB, Zero RB, Robust RB, Anchor TE, Late-Round QB, Balanced, Other. On save, the app also computes a suggested strategy from MY picks (e.g., 1 RB in rounds 1–2 and none until round 6 → suggest Zero RB) and shows it next to my manual choice; my manual choice always wins.
- Player names are normalized through `lib/players.js` before storage so "A.J. Brown", "AJ Brown" and "A.J. Brown PHI" are one player.

**Viewing and analytics:**
- Drafts list page: every saved draft as a row (date, site, type, strategy, rating), filterable by site, type, and strategy; sortable by date and rating. Clicking a row opens a detail page showing the full board with my picks highlighted, with edit and delete (delete requires a confirm click).
- Analytics page, computed across all saved drafts and respecting the same site/type/strategy filters:
  - Exposure report: every player I drafted, with count and % of drafts, sorted by % descending.
  - Strategy breakdown: count of drafts per strategy tag, with my average star rating per strategy.
  - Position-by-round table: for my picks, how often each position is taken in each round.

### Feature 2 — Analyst Compare (Phase 4)

- A page where I create named analysts (e.g., "FantasyPros ECR", "Analyst X") and paste each one's rankings as raw text. The ingester accepts both `rank. Player Name POS TEAM`-style lines and CSV-ish lines; rows it can't parse are listed visibly. Each saved ranking set records analyst name + date, so an analyst can have multiple dated sets.
- Compare view: pick 2–5 ranking sets → a single table, one row per player (matched via `lib/players.js`), one column per analyst, plus computed columns: average rank, max disagreement (highest minus lowest rank), and a consensus flag when all ranks are within 5 spots. Sortable by average rank and by disagreement. Players missing from an analyst's set show "—" and are flagged.
- "Copy Claude Prompt" button: generates and copies to clipboard a self-contained prompt containing the comparison data (top 60 by average rank) and instructions to analyze agreement, outliers, and actionable draft takeaways. The app does NOT call any AI API itself.

### Feature 3 — Converters (Phase 5)

- A page that converts pasted FantasyPros rankings (their CSV export format and their copy-paste rankings text) into a downloadable CSV in Underdog's rankings-upload format. Output preview is shown before download; rows that failed conversion are listed visibly.
- Conversion uses `lib/players.js` for name normalization. Structure the converter so input-format → internal list → output-format are separate steps, so new output formats can be added later as new files.

## Constraints

(CLAUDE.md is binding; in addition:)
- Yahoo API integration is future work: do not build it, but keep all parsing/normalization server-side in `lib/` so it can slot in later.
- No web scraping, no fetching from fantasy sites — all data arrives by paste or upload.
- No AI API calls and no API keys anywhere in v1.
- Dependencies for Phase 1 limited to: express, pg, dotenv, cookie-session (or equivalently minimal). Anything else: ask first.

## Definition of Done (per phase — self-verify before declaring victory)

1. `npm start` boots locally with no errors; `/health` returns JSON showing app ok + DB connected + migrations applied.
2. Every new page renders on a 390px-wide viewport without horizontal scroll, in dark theme.
3. Every API failure path shows a human-readable message in the page's error banner (test by stopping the DB or forcing a bad input).
4. Paste flows tested with at least one realistic sample input (include the sample used as a fixture file in `test-fixtures/`).
5. All earlier phases' checkpoint behaviors still work (re-run the previous phase's checkpoint test).
6. Committed and pushed; Railway deploy is green and the production URL works behind the password gate.

## Anti-goals (hard prohibitions)

- No user accounts, OAuth, or multi-user anything (the single APP_PASSWORD gate is the entire auth story).
- No Yahoo API work in v1. No scraping. No in-app AI calls.
- No React/SPA frameworks, no build step, no ORM, no TypeScript.
- No speculative features beyond this spec — if an idea seems valuable, list it in docs/IDEAS.md instead of building it.

## Working style

- Start in Plan Mode: present the Phase 1 plan (files, schema, routes) and get my approval before writing code.
- Make surgical edits, not full-file regenerations.
- Before any risky change (schema, deletes, refactors of working code), state the risk in one sentence.
- If context is running long mid-phase, write current state + next steps to docs/STATE.md so I can /compact or restart cleanly.
- Stop at each phase boundary and tell me exactly what to click/test in the browser.
