# All22 — To-Do / Follow-ups

_Updated 2026-07-07, end of the rebuild + first-features session. Everything
below the "Decisions" block is non-blocking; the app is live on Railway with
Combine (OCR confirmed working with Claude vision), Big Board, Playbook, Notes._
_Big phases live in `docs/SESSION_PLAN.md`; this file is the small stuff._

## Decisions waiting on the owner
- [ ] **Native .xlsx upload in Combine.** Needs the SheetJS npm dependency
      (rule: ask before adding any dependency). Shipped workaround: Excel →
      Save As → CSV → import (CSV importer auto-detects columns).
- [ ] **Owner's remaining issue list.** After the first OCR test he said "a few
      issues" — auction values, the Zero RB board, and CSV import are shipped;
      collect whatever else was on that list next session.

## Deployment / one-time
- [x] `ANTHROPIC_API_KEY` on Railway — DONE; owner tested OCR in prod, works.
- [ ] Re-match pre-rebuild ranking sets once (Combine → Sets → open each →
      **Re-match names**) — legacy sets were backfilled raw. Skip if already done.
- [ ] Confirm `COOKIE_SECRET` is set on Railway.

## Combine follow-ups
- [ ] **Verify Underdog & Yahoo export columns** (both flagged `verified:false`
      in `features/combine/lib/converters/`). The Underdog-with-IDs export
      sidesteps this and is the recommended path.
- [ ] Auction $ shows in the set view + Plain CSV export only; add to other
      exports if a need appears.
- [ ] Seed per-site alias blocks in `lib/aliases.js` from real lists; the
      review queue's "remember alias" grows `players_master.aliases` meanwhile.
- [ ] Tune the vision prompt on real ranker screenshots if a layout misreads
      (`features/combine/lib/vision.js`).
- [ ] Natural-language Q&A over the stored tables (PRD §9) — server-side key is
      in place; needs a read-only query surface + small UI.

## Big Board follow-ups
- [ ] Per-player note on a board — `board_players.note` exists in the schema
      but the UI doesn't expose it yet.
- [ ] Board export (CSV / Underdog) if wanted.

## Phase 2 gate — deep session FIRST, do not default (PRD §17)
- [ ] Cross-format blending, aggregation method, "unranked" semantics,
      tiers-vs-ordinals — settle in a dedicated session with the most capable
      model before building the custom model. Details in `docs/SESSION_PLAN.md`.

## Playbook (Phase 3 groundwork)
- [ ] Resolve picks to `player_id` via players_master on save (pages currently
      store raw names — fine for the log, required for analysis).
- [ ] Pre-rebuild correctness batch: timestamp drift on edit, pick validation
      messages, snake-math round assertion, batch pick INSERTs.

## Infra
- [ ] `npm test` in CI (GitHub Action). 50 tests, no DB needed.
- [ ] pg pool timeouts; SSL via env flag instead of URL-sniffing; process-level
      crash guard; stop news blocking the homepage on cold start.

## Dormant legacy (no rush)
- [ ] Drop `roster_cache`, `converter_corrections`, and the archived
      `ranking_sets.players` JSONB via a migration once the rebuild has been
      live and happy for a while.
