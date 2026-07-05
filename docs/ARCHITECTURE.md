# All22 architecture — the rebuilt portal

All22 is a **modular monolith**: one GitHub repo, one Railway project, one
Postgres, one login. The hub launches self-contained **sub-apps** (the PRD's
Combine / Playbook / Notes today; War Room and Edge Rush later), each isolated
in its own folder so adding or changing one never breaks another.

> The product spec is `docs/PRD.md` (gospel) and the build brief is
> `docs/KICKOFF.md`. One deliberate deviation from those documents: they chose
> Supabase + GitHub Pages because the owner had no terminal at the time. This
> rebuild keeps the already-proven Railway + Express + Postgres backbone
> instead — same schema, same features, but API keys stay server-side and the
> Phase-4 ADP scraper already has a home. Everything else in the PRD applies
> unchanged.

```
server.js                    boot: session gate, migrations, players_master
                             seed, mounts core routers + the feature registry
routes/auth.js               core: login/logout          (pre-auth)
routes/health.js             core: /health               (pre-auth)
routes/news.js               core: /api/news             (behind gate)
routes/settings.js           core: /api/settings         (behind gate)
routes/datahealth.js         core: /api/datahealth       (behind gate)
db/pool.js, db/migrate.js    shared pg pool + idempotent boot-time migrations
db/migrations/               numbered shared history; 012_all22_core.sql is the
                             rebuild's schema (players_master, rankings_*, …)
lib/players.js               canonical name cleanup + fuzzy matcher (pure)
lib/aliases.js               curated nickname/variant seed map
lib/players-master.js        the players_master service: Sleeper sync, match,
                             search, add-manual, learn-alias, status
lib/settings.js              settings table accessor (all dials live there)
lib/news/                    hub news aggregator (RSS)
public/                      hub (index.html), login.html, app.css, app.js
features/
  index.js                   the feature registry — the ONLY list of applets
  combine/                   RANKINGS HUB (PRD #1 job)
    router.js                /api/combine
    lib/vision.js            screenshot -> rows via Claude vision (fetch, no SDK)
    lib/ocr.js + tessdata/   offline Tesseract fallback
    lib/rankings.js          pasted-text -> rows parser
    lib/ingest.js            rows -> matched rows (pure; the ONE match pipeline)
    lib/store.js             ranking_sets / rankings_raw / rankings_normalized
    lib/converters/          CSV export writers (plain, Underdog, Yahoo, FP)
    lib/underdog-ids.js      reorder a real Underdog CSV to carry their IDs
    public/combine.html      ingest | sets | review | compare | settings
  playbook/                  DRAFT LOG (seed of the PRD's Playbook)
    router.js                /api/drafts (pre-rebuild draft tracker, reused)
    lib/parsers/             Underdog + FantasyPros paste parsers
    public/                  drafts.html, drafts-new.html, draft-detail.html
  notes/                     SCRATCHPAD
    router.js                /api/notes
    public/notes.html
```

## The one-click ingest pipeline (Combine)

```
screenshot(s) and/or pasted text
  -> vision.js (Claude, ANTHROPIC_API_KEY on the server)     — best path
     or ocr.js -> rankings.js                                — fallback path
  -> ingest.matchRows(rows, players_master index)            — never guesses
  -> store.createSet: ranking_sets + rankings_raw (+ rankings_normalized
     for confident matches)
  -> anything unmatched / uncertain appears in the Review queue
```

Identity rules:
- Rank = list order (printed rank digits are the least reliable thing OCR reads).
- A raw row with no `rankings_normalized` row IS the review queue; resolving it
  writes the normalized row (`confirmed = true`, `via = 'owner'`) and can teach
  a per-site alias stored on `players_master.aliases`.
- Re-match (`POST /api/combine/sets/:id/rematch`) re-runs matching for
  unconfirmed rows after a roster sync or new alias — also how sets migrated
  from the pre-rebuild converter get resolved.

## players_master lifecycle
- Seeded at first boot from Sleeper's free player list; refreshed daily and on
  demand (Combine -> Settings -> Sync). The 32 team defenses are always upserted.
- Owner-added players (`source = 'manual'`) are never deleted by a sync.
- The in-memory match index rebuilds at most every 10 minutes and immediately
  after any write.

## Auth & security
- One password (`APP_PASSWORD`), cookie session. `/health` and `/login` are the
  only unauthenticated routes.
- `ANTHROPIC_API_KEY` is server-only; the browser never sees it. Without it the
  app still works (Tesseract fallback + pasted text).
