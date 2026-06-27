# All22 — Fantasy Football Portal

Single-user fantasy football web app (draft tracking, analyst rankings comparison, data converters, Yahoo Fantasy API integration).
Deploys to Railway: push to `main` = production deploy. Postgres lives on Railway (`DATABASE_URL`).

## Architecture invariants (never violate)
- Node.js 20 + Express. Frontend is plain HTML/CSS/vanilla JS served from `public/` — **no build step, no React/Vue, no bundler**.
- Database access via `pg` with raw SQL — **no ORM**.
- Migrations: numbered SQL files in `db/migrations/` (e.g. `003_add_strategy.sql`), run idempotently at boot by `db/migrate.js`. Schema changes ONLY via new migration files — never edit an applied migration, never drop/rename columns without a migration.
- `lib/players.js` is the single canonical player-name normalization + fuzzy-matching module. All parsers, rankings ingestion, and converters MUST use it. Never duplicate name-matching logic elsewhere. `lib/aliases.js` is its companion: a curated + learned map of name variants/nicknames → canonical names, consulted by the matcher; add new aliases there, never inline.
- Single shared password gate via `APP_PASSWORD` env var (cookie session). No user accounts.
- Yahoo Fantasy API integration is **PLANNED, not built** — there is no `lib/yahoo.js` yet and no Yahoo routes. When/if built: OAuth 2.0 server-side only, credentials in `YAHOO_CLIENT_ID` / `YAHOO_CLIENT_SECRET` Railway env vars, token logic in `lib/yahoo.js`. It would be for connecting to MY Yahoo account — NOT a user login system. (Splash page shows it as "coming soon".)

## File layout (modular monolith — one repo, one Railway deploy, one login)
The portal is a splash page plus self-contained **feature modules**. Shared core stays at the root; each applet lives in its own folder so adding or changing one never touches another.
- `server.js` — Express app entry; mounts core routers, then loops `features/index.js` to mount each applet's API router + static pages.
- `features/index.js` — the feature registry (the ONE place applets are listed). Add an applet = new folder + one entry here.
- `features/<name>/` — a self-contained applet: `router.js` (its `/api` routes), `public/` (its pages, served at the site root), and optionally `lib/` and `test-fixtures/`. Current applets: `draft-tracker`, `rankings-converter`.
- `routes/auth.js`, `routes/health.js` — core (shared) routers: login/logout and `/health`.
- `lib/players.js` — shared canonical name logic + fuzzy matcher (used by every feature). `lib/aliases.js` — curated/learned name-alias map it consults. Other genuinely shared code lives in `lib/`.
- Tests: `*.test.js` next to the code they cover, run with `npm test` (Node's built-in runner, no deps). The name engine (`lib/players`, `lib/aliases`) and the converter parsers have golden tests — keep them green before pushing.
- `public/` — shared/core pages + assets: `index.html` (splash launcher), `login.html`, `app.css` (dark theme), `app.js` (`showError`/`clearError`/`apiFetch`).
- `db/pool.js`, `db/migrate.js` — one shared Postgres pool + boot-time migration runner.
- `db/migrations/` — numbered SQL migrations (shared history, single DB). Name new files with a feature prefix, e.g. `005_converter_ranking_sets.sql`; never edit an applied migration.

## Conventions
- API routes: `/api/<feature>/...` returning JSON `{ ok: true, data }` or `{ ok: false, error: "human-readable message" }`.
- Every page shows API errors in the shared `#error-banner` element — failures must be visible in the browser, never silent.
- Server logs: one-line `console.error` with route + message on every caught error.
- Mobile-friendly and dark-mode by default; owner checks the app on his phone.

## Workflow
- Local test: `npm start` (needs `DATABASE_URL` and `APP_PASSWORD` in `.env`); open http://localhost:3000.
- Deploy: commit + push to `main`; Railway auto-deploys. Verify with `/health` (reports app + DB status).
- Owner is non-technical: he cannot debug by reading code. Errors must be self-evident in the browser.

## Hard rules
- Never remove or simplify away a working feature to make something else easier.
- Ask before adding any npm dependency or CDN script.
- Prefer surgical edits over file rewrites.
- When a change could break existing data or pages, state the risk in one sentence before making it.
