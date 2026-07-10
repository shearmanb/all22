# All22 Session Plan — post-rebuild phasing (PRD §16)

One phase per session (or two short ones). After each phase, run the checkpoint
in the browser (phone!) before continuing.

## ✅ Phase 0 — Foundation (DONE, this rebuild)
Schema (`012_all22_core.sql`: players_master, ranking_sets metadata,
rankings_raw/normalized, my_rankings, adp_history, notes, settings), the
players_master service with daily Sleeper sync, hub shell with launcher cards +
data-health panel + global league settings, docs.

## ✅ Phase 1 — Combine: one-click rankings ingestion (DONE, this rebuild)
Screenshot(s)/paste → Claude vision (Tesseract fallback) → matched against
players_master → saved with source + date + native scoring format → review
queue for anything uncertain → set view, compare, exports (CSV / Underdog /
Yahoo / FantasyPros / Underdog-with-IDs).
**Checkpoint:** on your phone, ingest a REAL ranking screenshot end-to-end in
one click; fix any flagged rows in Review; export the Underdog file and upload
it; confirm the hub's data-health panel shows the new set as fresh.

## 🟡 Phase 2 — Custom model + dials (v1 BUILT as My Rankings; dials to confirm)
The mini-ECR blender shipped 2026-07-10: per-ranker weights, unranked-semantics
dial, trim outlier tamping, min-sets, target format from league profiles,
versioned runs + compare + exports. The deep-session decisions were NOT
silently picked — they are visible dials with provisional defaults (unranked =
no-opinion, outliers = off, cross-format = warn-don't-adjust). **Still owed: a
session confirming those defaults, and tiers-vs-ordinals remains unbuilt.**

## Phase 3 — Playbook grows up
Draft ingestion beyond paste (decide the Yahoo/Underdog extraction path),
Draft-Wizard-style analysis: value vs. ADP, reaches/steals, positional balance.
Picks should resolve to `player_id` via players_master (the current pre-rebuild
pages store raw names).

## ✅ Phase 4 — Edge Rush (BUILT 2026-07-10, sources differ from the sketch)
Daily automatic ADP into `adp_history` from FantasyFootballCalculator (free
documented API, per format + league size, includes the pick distribution
Phase 5 needs) and Sleeper (exact sleeper_id joins) — not Yahoo/Underdog/ESPN,
which have no sane free feeds (see docs/INTEGRATIONS.md). Scheduled in this
Railway service (boot + 6h re-check); risers/fallers + freshness live.

## Phase 5 — War Room
Draft/auction strategy simulator: % chance a player is available at your next
pick (needs an ADP *distribution*, not just the mean — see open decision 4).

## Throughout
Hub data-health, Notes, and the natural-language Q&A surface (PRD §9 — read-only
questions over the stored tables via the Anthropic API; the server-side key is
already in place once OCR uses it).

---

# Open decisions — flagged, NOT silently picked (PRD §17)

1. **Cross-format blending.** Averaging a standard list with a PPR list is
   wrong. Pragmatic v1 per the PRD: pull each source at the format closest to
   your league and let per-ranker weighting close the gap; exact adjustment
   needs projection-level points-per-stat data. *Schema is ready either way
   (native format is stored per set; target format per run).*
2. **Model aggregation method.** Trimmed mean vs. weighted median vs.
   normalize-then-blend — different rankers have different scales. Deep-session
   candidate.
3. **"Unranked" semantics.** Does a ranker omitting a player mean "no opinion"
   (exclude from that ranker's vote) or "ranked last"? Materially changes the
   blend. Deep-session candidate.
4. **% availability math** (War Room). Needs an ADP distribution; decide how to
   estimate spread from the sites we can actually scrape.
5. **Tiers vs. ordinals.** How tier-based rankings fold into a numeric blend.
6. **Getting draft data out of Yahoo/Underdog** (Playbook). Bookmarklet on the
   rendered board vs. screenshot→OCR vs. manual export — pick per platform.
7. **Same-tab vs. new-tab** hub launching (currently same-tab).
