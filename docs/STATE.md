# All22 Session State

_Last updated: 2026-06-13_

## Branch
- Working branch: `claude/great-allen-o10s5a`
- Both `claude/great-allen-o10s5a` and `main` are in sync at commit `290e672`
- Railway auto-deploys from `main`

## Completed Phases

### Phase 1 — Scaffold ✅
- `server.js`: Express, cookie-session password gate (APP_PASSWORD), pg pool, auth middleware
- `db/pool.js`: pg pool with idle-error handler (survives DB drop/recovery)
- `db/migrate.js`: idempotent migration runner tracking applied files in `schema_migrations`
- `db/migrations/001_initial.sql`: placeholder
- `routes/health.js`: GET /health → `{ok, app, db, migrations}`, HTTP 503 if DB down
- `routes/auth.js`: GET/POST /login, POST /logout
- `public/login.html`, `public/index.html`, `public/app.css`, `public/app.js`

**Checkpoint passed**: Railway production URL, password gate, /health, dark theme mobile-friendly.

### Phase 2 — Draft Tracker Core ✅
- `db/migrations/002_drafts.sql`: `drafts` + `picks` tables, cascade delete index
- `db/migrations/003_datetime.sql`: `drafted_at` DATE → TIMESTAMPTZ (supports multiple drafts/day)
- `db/migrations/004_draft_flags.sql`: `is_test BOOLEAN`, `checked_out_at INT` on drafts
- `lib/players.js`: `normalize(name)` (lowercase key) + `clean(name)` (display). Strips Jr/Sr/II/III, periods (A.J.→AJ), collapses whitespace.
- `lib/strategy.js`: `suggest(myPicks)` → Anchor TE > Robust RB > Hero RB > Late-Round QB > Zero RB > Balanced
- `lib/parsers/underdog.js`: Single-line format `R.SS PlayerName POS TEAM`. Snake-draft slot/overall computation. Handles R.S, overall-only, comma variants, round headers.
- `lib/parsers/fantasypros.js`: Auto-detects two formats. Normalizes `\r\n` → `\n` before detection (fixes browser paste bug).
  - **Full board** ("Rd N" headers): 3-line blocks (FirstName/LastName/TEAM-POS), teams in draft-slot column order, "Redo" marks user's column to infer mySlot. 204 picks from 17-round 12-team draft, 0 unparseable.
  - **Team view** ("Starters"/"Bench" headers): individual pick blocks with (Bye N) and R.SS notation, all picks marked isMyPick=true, mySlot inferred from R1.
- `lib/parsers/index.js`: Registry with underdog + fantasypros; fallback to underdog.
- `routes/drafts.js`:
  - POST /parse → returns picks, unparseable, inferredMySlot, **suggestedStrategy**, **positionCounts**
  - GET / → list with filters (site/draftType/strategy), sort by date or rating
  - POST / → save draft + picks; computes suggestedStrategy, stores is_test + checked_out_at
  - GET /:id → detail with picks
  - PUT /:id → edit metadata including is_test + checked_out_at
  - DELETE /:id → cascade deletes picks
- `public/drafts-new.html`:
  - Site dropdown (Underdog/FantasyPros/Yahoo/Sleeper/Other)
  - datetime-local input (defaults to now)
  - "Checked out at pick #" + "Test draft" checkbox
  - paste→parse→preview table (editable cells, mine checkbox, add/remove rows)→save
  - After parse: system analysis bar shows suggested strategy + position counts (e.g. 2 QB · 4 RB · 6 WR)
  - Auto-fills mySlot from inferredMySlot
- `public/drafts.html`: Filterable (site/type/strategy) sortable list. Shows full datetime. TEST badge on test drafts.
- `public/draft-detail.html`: Full pick board (mine highlighted blue), inline metadata edit (datetime-local, is_test, checked_out_at), double-confirm delete. Position counts shown in pick header.
- `test-fixtures/underdog-sample.txt`: 36-pick 3-round Underdog fixture
- `test-fixtures/fantasypros-sample.txt`: 17-pick team-view fixture
- `test-fixtures/fantasypros-board.txt`: 204-pick full-board fixture (user's real draft, 12 teams, 17 rounds)

**Checkpoint passed**: FantasyPros full-board paste works (204 picks, 17 mine, slot=3). System strategy suggestion + position counts display confirmed working.

## Next Steps

### Phase 3 — Draft Analytics
Per `docs/SESSION_PLAN.md`:
- Exposure report: every player drafted, count + % of drafts, sorted by % descending
- **Exclude `is_test = true` drafts by default; add toggle to include them**
- Top trends: most-drafted player, most-used strategy, avg draft slot
- Strategy breakdown: count per strategy + avg rating
- Filters: same site/type/strategy filters as list page
- Key: same player pasted with different name spellings → ONE row (uses `lib/players.js` normalize)
- Route: `routes/analytics.js` → GET /api/analytics (accepts same filter params as /api/drafts)
- Page: `public/analytics.html`

### Phase 4 — Analyst Compare
### Phase 5 — Converters
### Phase 6 — Yahoo Fantasy API (requires Yahoo Developer app pre-work)

## Key Architecture Reminders
- No ORM, raw SQL via `pg`
- No build step, plain HTML/CSS/vanilla JS in `public/`
- All name matching through `lib/players.js` only
- Migration files numbered, never edited after applied
- API: `{ok: true, data}` or `{ok: false, error}`
- Every page has `#error-banner` populated by `showError()` in `app.js`
- Railway env vars needed: `DATABASE_URL` (from Postgres plugin), `APP_PASSWORD`, `COOKIE_SECRET`

## Git Config (required for signed commits)
```
git config user.email noreply@anthropic.com
git config user.name Claude
```
allowedSignersFile: `/home/claude/.ssh/allowed_signers`
Public key: `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKy87HxSEheG8vEPhSs9u2KZCtVErAQfpmprtUJCZ2w7`
