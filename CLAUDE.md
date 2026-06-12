# All22 — Fantasy Football Portal

Single-user fantasy football web app (draft tracking, analyst rankings comparison, data converters).
Deploys to Railway: push to `main` = production deploy. Postgres lives on Railway (`DATABASE_URL`).

## Architecture invariants (never violate)
- Node.js 20 + Express. Frontend is plain HTML/CSS/vanilla JS served from `public/` — **no build step, no React/Vue, no bundler**.
- Database access via `pg` with raw SQL — **no ORM**.
- Migrations: numbered SQL files in `db/migrations/` (e.g. `003_add_strategy.sql`), run idempotently at boot by `db/migrate.js`. Schema changes ONLY via new migration files — never edit an applied migration, never drop/rename columns without a migration.
- `lib/players.js` is the single canonical player-name normalization module. All parsers, rankings ingestion, and converters MUST use it. Never duplicate name-matching logic elsewhere.
- Single shared password gate via `APP_PASSWORD` env var (cookie session). No user accounts.

## File layout
- `server.js` — Express app entry; mounts routes from `routes/`
- `routes/<feature>.js` — one router per feature (drafts, rankings, convert)
- `lib/` — shared logic (players.js, parsers/, etc.)
- `public/` — static pages, one HTML file per page; shared `app.css` (dark theme) and `app.js`
- `db/migrations/` — numbered SQL migrations

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
