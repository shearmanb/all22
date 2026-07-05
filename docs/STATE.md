# All22 Session State

_Last updated: 2026-07-05_

## Branch
- Working branch: `claude/fantasy-pros-redesign-082rjd` (the full rebuild)
- Railway auto-deploys from `main` — merge the branch to deploy.

## What just happened: the rebuild
The app was torn down and rebuilt around `docs/PRD.md` (gospel). What changed:

- **New schema (012):** `players_master` (the linchpin registry, synced daily
  from Sleeper), `rankings_raw` + `rankings_normalized` under the existing
  `ranking_sets` (extended with `native_scoring_format` / `captured_on`),
  plus `my_rankings`, `adp_history`, `notes`, `settings` created for later
  phases. Pre-rebuild saved sets were backfilled into `rankings_raw` — open
  each old set once and hit "Re-match names" to resolve them.
- **Combine** replaced the Rankings Converter (`/combine.html`, `/api/combine`):
  one-click screenshot→OCR→match→save, review queue, set compare, all the old
  exports including Underdog-with-IDs. OCR is Claude vision when
  `ANTHROPIC_API_KEY` is set on Railway, Tesseract fallback otherwise.
- **Playbook** is the renamed draft tracker (same pages, same `/api/drafts`,
  same data). It becomes the PRD's Playbook in Phase 3.
- **Notes** is new (`/notes.html`).
- **Hub** redesigned: launcher cards with live stats, per-dataset data-health
  panel, global league-profile settings, news aggregator retained.
- Kept verbatim: `lib/players.js` matcher + tests, `lib/aliases.js`, export
  converters, underdog-ids, text parser, news, auth/health, db plumbing.
- Dormant legacy tables (kept, unread): `roster_cache`,
  `converter_corrections`. `converter_aliases` is still read into the alias
  map; new learned aliases go to `players_master.aliases`.

## To finish deployment
1. Merge to `main`; Railway builds and runs migration 012 at boot (verified
   locally against a scratch Postgres, including the legacy backfill).
2. Add `ANTHROPIC_API_KEY` in Railway → Variables for Claude-vision OCR
   (optional but strongly recommended; the UI nags until it's set).
3. First boot seeds `players_master` from Sleeper automatically; check the
   hub's data-health panel.

## Next sessions
See `docs/SESSION_PLAN.md` — Phase 2 (the model) needs its deep-session
decisions settled first; TODO.md carries the small follow-ups.
