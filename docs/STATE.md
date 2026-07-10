# All22 Session State

_Last updated: 2026-07-10_

## Branch
- Working branch: `claude/fantasy-league-features-zmlgcn`
- Railway auto-deploys from `main` — merge the branch to deploy.

## What just happened: the overnight feature batch
Built on top of the PRD rebuild (see git history for the rebuild notes):

- **Multi-league profiles** — hub "My leagues" manages `league.profiles`
  (teams / scoring / flex spots / superflex / TE premium / auction) with
  `league.active` as default. CLAUDE.md now forbids hardcoding league shape.
- **My Rankings** (`/myrankings.html`) — the mini-ECR blender: weighted
  consensus of selected sets, overall + per-position, with the open-decision
  dials in the UI (unranked semantics, trim outlier tamping, min-sets, target
  format from the active league). Saved runs (frozen snapshots), run-vs-run
  risers/fallers, ADP-delta column, exports via the existing converters.
- **Edge Rush** (`/adp.html`) — automatic daily ADP: FantasyFootballCalculator
  (per format + league size, with spread) + Sleeper (all formats, exact
  `sleeper_id` joins). Boot + 6h re-check schedule; 7-day movers; collector
  settings; league-aware defaults.
- **Player DB** (`/players.html`) — browse/search `players_master`, see and
  edit per-site aliases, sync button, stats.
- **Combine URL fetch + auto-pull** — pull FantasyPros consensus pages by URL
  (embedded `ecrData`, balanced-brace extraction), with an optional daily
  auto-pull list that saves fresh dated sets automatically.
- **Migration 018** — adp_history dimensions, `players_master.sleeper_id`
  (+ forced resync), run names, my_rankings `detail` JSONB.
- Docs: `docs/INTEGRATIONS.md` answers the Yahoo-live-draft question and the
  "how do we auto-get rankings" question.

## To verify after deploy (owner or next session)
1. Merge to `main`; watch `/health` for migration 018.
2. Hub → My leagues: enter every real league (this drives Edge Rush's feeds
   and My Rankings' target default).
3. Edge Rush → Collect now: confirm FFC + Sleeper feeds fetch from Railway
   (this sandbox couldn't reach them — proxy). Check unmatched counts.
4. Combine → Ingest → fetch a FantasyPros URL end-to-end; optionally add it
   to the daily auto-pull list.
5. My Rankings → blend 2+ sets, save a run, export, compare.
6. **Confirm the model dials** (unranked = no-opinion default, outlier trim
   off by default, min-sets 1) — the deep-session decisions are provisional.

## Next sessions
War Room (Phase 5) now has its ADP distribution data accumulating. Yahoo
draft capture: decide bookmarklet vs OAuth polling (docs/INTEGRATIONS.md).
