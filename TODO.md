# All22 — To-Do / Follow-ups

Open items deferred for later (not blocking; everything below is live on Railway).

## Rankings Converter

- [x] **Nickname alias table.** DONE. `lib/aliases.js` is a curated map (variant →
  canonical) consulted by the matcher, plus DB-backed *learned* aliases
  (`converter_aliases`, API at `/api/convert/aliases`) so the list grows from real
  use. To extend: add to a block in `lib/aliases.js` (per-site blocks already
  scaffolded for FantasyPros/Underdog/Yahoo/FanDuel/Fantasy Points/Fantasy Labs).
  Follow-ups: (a) seed each site's known quirks from a real list; (b) wire the
  "remember this player" UI button in `convert.html` to POST `/aliases` (next batch).

- [ ] **Verify Underdog & Yahoo export columns.** Both converters
  (`features/rankings-converter/lib/converters/underdog.js`, `yahoo.js`) are
  flagged `verified: false` ("verify columns"). Download a current template/CSV
  from each site, confirm the header row matches what we emit, then flip
  `verified` to `true` (and adjust the COLUMNS line if needed). The plain CSV and
  FantasyPros exports are already verified.

## Review-driven roadmap (June 2026)

From the full code/feature review. **Batch 1 — Matching engine — DONE** (golden
tests + `npm test`; unified resolution with alias precedence; `lib/aliases.js`;
position/team-aware dedupe; Postgres roster cache + outage fallback; consistent
pipeline; per-player match confidence on the API). Remaining batches, in order:

- [ ] **Batch 2 — Confidence & self-correction UI (convert.html).** Surface the new
  `lowConfidence` count + per-row `p.match.confidence` as a "⚠ confirm" badge;
  let the owner accept/fix a flagged match; "remember this player" → POST
  `/api/convert/aliases`. Show OCR mean confidence and nudge to paste-as-text when
  low (Tesseract returns per-word confidence we currently discard). [review 3a/3b/3f]
- [ ] **Batch 3 — Frontend cleanup.** Hoist one correct `esc()` + `$()` into
  `app.js` and delete the four per-page copies (one is XSS-buggy in
  `drafts-new.html`); factor the 4 duplicated list-renderers in `convert.html`
  into one `renderList()`; add `apiFetchBlob()` for CSV/Underdog downloads. [4a/4b/5a/5b/5e]
- [ ] **Batch 4 — Stability/infra.** `npm test` in CI (GitHub Action); pg pool
  timeouts; stop news blocking the homepage; require `COOKIE_SECRET` + set
  `secure`/`trust proxy`; process-level crash guard; SSL via env not URL-sniff;
  denormalize draft pick counts. [2a–2e/4f/2j]
- [ ] **Batch 5 — Draft-tracker correctness.** Fix timestamp drift on edit;
  validate picks with row-level messages; snake-math round assertion; make the
  Edit site `<select>` match New; batch the per-row pick INSERTs. [4c/4d/4e/3c/2g]
- [ ] **Batch 6 — Fix-queue filters** (new request). Filter/search the saved fixes
  list in `convert.html`.

### Planned new features (owner-driven)

- [ ] **Consensus rankings (6b).** Average multiple saved ranking sets into a
  composite, with per-player disagreement (std-dev) = where the market is soft.
  Builds on existing `ranking_sets`. The owner is actively planning this — design
  with it in mind (keep saved sets clean and comparable).
- [ ] **Player notes & tags (6g).** Personal notes + tags (sleeper/avoid/handcuff)
  keyed on the canonical `players.key()` so they follow a player across every
  source spelling. NO new master player DB needed — the `roster_cache` table
  (Batch 1) is the canonical player list; notes just reference the key.
- [ ] Other review ideas parked for later: ADP value board (6a), live draft board
  (6c), auto-tiers (6d), bye/roster-construction (6e), player→news links (6f),
  ranking-set diff (6h), "who's left at my pick" sim (6i), printable cheat sheet (6j).
