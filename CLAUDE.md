# All22 — Fantasy Football Nerve Center

Single-user app (PRD: `docs/PRD.md` — treat it as gospel): ingest other people's
rankings, mesh them into custom personal rankings, track/analyze drafts, pull
ADP. Sub-apps: **Combine** (rankings hub, built), **Playbook** (draft log,
seeded), **Notes** (built), **War Room** + **Edge Rush** + the custom model
(later phases — see `docs/SESSION_PLAN.md`).
Deploys to Railway: push to `main` = production deploy. Postgres lives on
Railway (`DATABASE_URL`).

## Architecture invariants (never violate)
- Node.js 20 + Express. Frontend is plain HTML/CSS/vanilla JS served from `public/` and each feature's `public/` — **no build step, no React/Vue, no bundler**.
- Database access via `pg` with raw SQL — **no ORM**.
- Migrations: numbered SQL files in `db/migrations/` (e.g. `012_all22_core.sql`), run idempotently at boot by `db/migrate.js`. Schema changes ONLY via new migration files — never edit an applied migration, never drop/rename columns without a migration.
- **`players_master` is the linchpin.** Every dataset (rankings, ADP, drafts) joins on `player_id`. It's seeded/refreshed daily from Sleeper's free player list via `lib/players-master.js` (which also owns match/search/addManual/learnAlias). Never bypass it.
- `lib/players.js` is the single canonical name-normalization + fuzzy-matching module; `lib/aliases.js` is its curated alias seed. `lib/players-master.js` layers the DB registry on top. All ingestion MUST resolve names through this stack — never duplicate name-matching logic.
- **Never silently guess a player's identity.** Confident matches write through to `rankings_normalized`; low-confidence or unknown names stay visible in the review queue (a raw row with no normalized row, or an unconfirmed non-high match) until the owner confirms, corrects, adds the player, or ignores the row.
- **Native scoring format is the input's identity.** Every ranking set carries `native_scoring_format` (`ppr|half|standard|best_ball|superflex|unknown`) — the format the source was *published* in. Never rewrite it. The owner's league target lives separately in settings (`league.profile`).
- **Every dial lives in the `settings` table** (key/value JSONB), editable in the UI — tweaks never require a code edit.
- Screenshot OCR: **Claude vision** via `features/combine/lib/vision.js` (server-side `ANTHROPIC_API_KEY`, plain fetch, no SDK), with the bundled Tesseract pipeline (`ocr.js`) as automatic fallback when the key is missing or a call fails. The key must NEVER reach the browser.
- Single shared password gate via `APP_PASSWORD` env var (cookie session). No user accounts.

## File layout (modular monolith — one repo, one Railway deploy, one login)
Hub (splash) + self-contained **feature modules**. Shared core at the root; each applet in its own folder.
- `server.js` — Express entry; mounts core routers, then loops `features/index.js` to mount each applet's API router + static pages. Boot also runs migrations and a background `players_master` seed/refresh.
- `features/index.js` — the feature registry (the ONE place applets are listed). Add an applet = new folder + one entry here.
- `features/combine/` — the rankings hub (#1 job): `router.js` (`/api/combine`), `lib/` (vision, ocr, rankings text parser, csv-import, ingest matching pipeline, store, converters/, underdog-ids), `public/combine.html`. Ingest sources: screenshot→OCR, paste-as-text, and CSV/spreadsheet import (auto-detects columns; Excel via Save-As-CSV). Optional per-row `auction_value` rides on `rankings_raw`.
- `features/auction/` — War Chest, the auction budget calculator (`/api/auction`, `auction.html`): per-auction config (teams, budget, roster slots), one budget row per slot (plan $ / player / paid $), must-have/want/watch target lists. Player values come from ingested ranking sets carrying `auction_value` (per-auction source pick or latest-any), scaled by the expensive-mode `price_mult_pct` dial; "suggest plans" budgets every open slot from them. All arithmetic lives in `public/auction-math.js` — shared verbatim by the router and the browser (UMD wrapper, no build step), golden-tested.
- `features/playbook/` — draft log & analysis (`/api/drafts`; the old draft tracker, seed of the PRD's Playbook): parsers for Underdog/FantasyPros paste, drafts pages.
- `features/notes/` — scratchpad (`/api/notes`, `notes.html`).
- `routes/` — core (shared) routers: `auth.js`, `health.js` (unauthenticated), `news.js`, `settings.js`, `datahealth.js` (behind the gate).
- `lib/` — `players.js`, `aliases.js`, `players-master.js`, `settings.js`, `news/`.
- `db/pool.js`, `db/migrate.js`, `db/migrations/` — one shared Postgres pool + boot-time migration runner + numbered history.
- `public/` — hub (`index.html` with launcher cards, data-health panel, global settings, news), `login.html`, `app.css` (the design system), `app.js` (shared helpers: `$`, `esc`, `apiFetch`, `apiPost`, `apiDownload`, `timeAgo`, `toast` — use these, never re-declare per page).
- Tests: `*.test.js` next to the code they cover, `npm test` (Node's built-in runner, no deps). The name engine, ingest pipeline, vision parser, converters and text parser have golden tests — keep them green before pushing.

## Data model (migration 012; PRD §5)
- `players_master` — canonical `player_id`, name, `name_key`, position, team, per-site `aliases` JSONB, `source` (`sleeper|manual`).
- `ranking_sets` — set metadata: name, source, `native_scoring_format`, `captured_on`, notes. (Pre-rebuild converter saves were backfilled from its legacy JSONB `players` column, which is retained as a read-only archive.)
- `rankings_raw` — every ingested row exactly as captured (`set_id`, rank, raw name/pos/team). Rank = list order, by design (printed ranks are OCR-unreliable).
- `rankings_normalized` — raw row resolved to a `player_id` + confidence/via/confirmed. Missing row here = review queue.
- `my_ranking_runs` + `my_rankings`, `adp_history` — created for Phases 2/4, not written yet.
- `drafts` + `picks` — Playbook's tables (pre-rebuild, reused as-is).
- `auctions` + `auction_slots` + `auction_targets` (migration 015) — War Chest: config, one row per roster slot (`plan`/`player_id`/`player_name`/`paid`; `paid IS NULL` = open slot), target tiers (`must|want|watch`).
- `notes`, `settings` — scratchpad + control panel.
- Legacy tables kept but dormant: `roster_cache`, `converter_corrections` (superseded by players_master), `converter_aliases` (still read into the alias map; new learned aliases go to `players_master.aliases`).

## Conventions
- API routes: `/api/<feature>/...` returning JSON `{ ok: true, data }` or `{ ok: false, error: "human-readable message" }`.
- Every page shows API errors in the shared `#error-banner` element — failures must be visible in the browser, never silent.
- Server logs: one-line `console.error` with route + message on every caught error.
- Mobile-friendly and dark-mode by default; owner checks the app on his phone.

## Workflow
- Local test: `npm start` (needs `DATABASE_URL` and `APP_PASSWORD` in `.env`; `ANTHROPIC_API_KEY` optional — OCR falls back to Tesseract without it); open http://localhost:3000.
- Deploy: commit + push to `main`; Railway auto-deploys. Verify with `/health` (app + DB + applied migrations).
- Owner is non-technical: he cannot debug by reading code. Errors must be self-evident in the browser.

## Open decisions — do NOT silently pick (PRD §17; details in docs/SESSION_PLAN.md)
Cross-format blending, model aggregation method, "unranked" semantics, and
tiers-vs-ordinals are flagged for a dedicated deep session before Phase 2.
Getting draft data out of Yahoo/Underdog is open before Playbook grows.

## Hard rules
- Never remove or simplify away a working feature to make something else easier.
- Ask before adding any npm dependency or CDN script.
- Prefer surgical edits over file rewrites.
- When a change could break existing data or pages, state the risk in one sentence before making it.
