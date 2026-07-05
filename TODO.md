# All22 — To-Do / Follow-ups

Open items after the PRD rebuild (branch `claude/fantasy-pros-redesign-082rjd`).
The big phases live in `docs/SESSION_PLAN.md`; this file is the small stuff.

## Deployment
- [ ] Add `ANTHROPIC_API_KEY` to Railway → Variables (Claude-vision OCR; the
      app falls back to Tesseract and nags in the UI until set).
- [ ] After first deploy: open each pre-rebuild ranking set and hit
      **Re-match names** once (legacy sets were backfilled raw; matching runs
      against the freshly seeded players_master).
- [ ] Set `COOKIE_SECRET` on Railway if not already present.

## Combine follow-ups
- [ ] **Verify Underdog & Yahoo export columns** (carried over from before the
      rebuild). `features/combine/lib/converters/underdog.js` and `yahoo.js`
      are flagged `verified: false` — download a current template from each
      site, confirm headers, flip the flag. (The Underdog-with-IDs export
      sidesteps this and is the recommended path.)
- [ ] Consider seeding per-site alias blocks in `lib/aliases.js` from real
      lists (FantasyPros/Underdog/Yahoo quirks). The review queue's
      "remember alias" flow grows `players_master.aliases` organically either way.
- [ ] Tune the Claude-vision prompt on real screenshots from your rankers; if a
      site's layout confuses it, add an example to the prompt in
      `features/combine/lib/vision.js`.
- [ ] Natural-language Q&A over the stored tables (PRD §9) — server key is in
      place once OCR uses it; needs a read-only query surface + a small UI.

## Playbook (Phase 3 groundwork)
- [ ] Resolve picks to `player_id` via players_master on save (pages currently
      store raw names — fine for the log, required for analysis).
- [ ] Pre-rebuild correctness batch (still valid): timestamp drift on edit,
      pick validation messages, snake-math round assertion, batch pick INSERTs.

## Infra (carried over, still worth doing)
- [ ] `npm test` in CI (GitHub Action).
- [ ] pg pool timeouts; SSL via env flag instead of URL-sniffing; process-level
      crash guard; stop news blocking the homepage on cold start.

## Dormant legacy (decide later, no rush)
- [ ] `roster_cache` and `converter_corrections` tables are no longer read —
      drop via a migration once the rebuild has been live and happy for a while.
      `ranking_sets.players` (JSONB archive of pre-rebuild saves) same deal.
