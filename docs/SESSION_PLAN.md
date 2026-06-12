# All22 Session Plan

One phase per Claude Code session (or two short ones). After each phase, run the checkpoint in your browser before saying "continue".

## Phase 1 — Scaffold + deploy pipeline
Express app, password gate, Postgres connection, migration runner, `/health`, base layout (nav, dark theme, error banner), empty home page. Deploy to Railway.
**Checkpoint:** Open the Railway production URL on your phone → password prompt → home page renders dark. Visit `/health` → shows app + DB ok. Enter a wrong password → clear error message.
**Model:** Sonnet-class is fine.

## Phase 2 — Draft Tracker core
Drafts/picks schema, `lib/players.js` normalization, Underdog paste-parser with preview + manual correction, save flow, drafts list + detail pages, edit/delete, strategy tag with auto-suggestion.
**Checkpoint:** Paste a REAL Underdog draft you copied. Verify: every pick appears in the preview with correct round/player/position; unparsed lines (if any) are listed, not dropped; after saving, the detail page highlights your picks; the suggested strategy is sane. Edit one pick, delete a test draft.
**Model:** Maximum reasoning (parser + name normalization is the project's hardest logic). Do this phase before June 22 while Fable is available.

## Phase 3 — Draft analytics
Exposure report, strategy breakdown with avg rating, position-by-round table, shared filters.
**Checkpoint:** Log 3+ drafts (mix sites/strategies). Exposure %s match hand-count; the same player pasted with slightly different name spellings appears as ONE row; filters change all three reports consistently.
**Model:** Sonnet-class fine.

## Phase 4 — Analyst Compare
Analyst + ranking-set ingestion, comparison table (avg rank, disagreement, consensus flag), Claude prompt generator.
**Checkpoint:** Paste rankings from 3 real analysts. Spot-check 5 players' ranks against sources; a player missing from one set shows "—"; "Copy Claude Prompt" produces a prompt that, pasted into Claude, yields a useful comparison.
**Model:** Maximum reasoning for ingestion/matching; UI polish can be a faster model.

## Phase 5 — Converters
FantasyPros → Underdog CSV converter with preview and visible failure list.
**Checkpoint:** Convert a real FantasyPros export and upload the resulting CSV to Underdog — it must be accepted by Underdog's uploader. (Grab Underdog's current expected format/sample first; formats drift season to season.)
**Model:** Mid — but verify Underdog's current CSV column spec manually, don't trust memory.

## Later (not scheduled)
Yahoo Draft API (OAuth, server-side — architecture already keeps logic in `lib/`), more site parsers, in-app AI analysis via API key.

## Top risks & early-warning signs
1. **Paste-parser brittleness** — draft sites change their copy format. *Sign:* a real paste yields many "couldn't parse" lines. *Mitigation already in spec:* preview + manual correction means a broken parser degrades to manual entry, never data loss.
2. **Player-name matching** — suffixes (Jr./II), punctuation, team tags, same-name players. *Sign:* duplicate rows in the exposure report or wrong matches in Analyst Compare. *Response:* fix in `lib/players.js` only, add the failing pair to `test-fixtures/`.
3. **Works locally, fails on Railway** — env vars, port binding, migration order. *Sign:* green local, crashed deploy. *Response:* check Railway logs for `DATABASE_URL`/`PORT`/migration errors; `/health` isolates app vs DB.
