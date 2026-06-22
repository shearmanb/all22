# All22 architecture — multi-applet portal

All22 is a **modular monolith**: one GitHub repo, one Railway project, one login.
A splash page launches several self-contained **applets**, each isolated in its
own folder so adding or changing one never breaks another.

```
server.js                 boot, session, password gate, mounts features
routes/auth.js            core: login / logout
routes/health.js          core: /health
db/pool.js, db/migrate.js shared Postgres pool + boot-time migration runner
db/migrations/            shared migration history (one DB); feature-prefixed files
lib/players.js            shared canonical player-name logic (used by all applets)
public/                   splash (index.html), login.html, app.css, app.js (shared)
features/
  index.js                the feature registry — the ONLY place applets are listed
  draft-tracker/
    router.js             /api/drafts
    lib/                  strategy.js, draft-board parsers
    public/               drafts.html, drafts-new.html, draft-detail.html
  rankings-converter/
    router.js             /api/convert
    lib/                  rankings parser, converters/, ocr.js
    public/               convert.html
    tessdata/             bundled offline OCR model
```

## How a request is served
`server.js` mounts the core routers (health, auth) and the password gate, then
loops `features/index.js`. For each feature it does:
`app.use(feature.apiMount, feature.router)` and
`app.use(express.static(feature.publicDir))`. Feature pages are served at the
site root, so `/drafts.html` and `/convert.html` resolve directly (page
filenames are unique across features).

## Adding a new applet (no existing feature is touched)
1. Create `features/<name>/` with a `router.js` (exports an Express `Router`) and
   a `public/` folder with its page(s).
2. Put any feature-only code in `features/<name>/lib/`; reuse `lib/players.js`
   for name normalization — never duplicate it.
3. If it needs storage, add a feature-prefixed migration, e.g.
   `db/migrations/00N_<name>_*.sql` (one shared database; never edit an applied
   migration).
4. Add one entry to `features/index.js`:
   `{ name, label, apiMount: '/api/<name>', router, publicDir }`.
5. Add a tile to `public/index.html` and a nav link.

That's it — the splash, gate, database, and other applets are untouched.

## Shared vs isolated
- **Shared:** one password gate (`APP_PASSWORD`), one Postgres pool, the
  player-name module, the dark theme + `app.js` helpers, the splash launcher.
- **Isolated per applet:** its routes, pages, feature-only libs, and its own
  database tables (added via its own migration files).
