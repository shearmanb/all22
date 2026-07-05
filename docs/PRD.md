# All22 — Product PRD

**Owner:** Brad
**Status:** Draft v0.2 (supersedes the hub-shell-only draft; hub shell now folded in as one component)
**Type:** Lightweight spec, built to feed Claude Code kickoff prompts
**User:** Single user (you). No auth, no multi-tenant, no accounts.

---

## 1. Vision

All22 is your fantasy football nerve center: one place to ingest other people's rankings, mesh them into *your* personal tweaked rankings via a custom model, track and analyze your mock/Best Ball drafts, and pull fresh ADP intelligence — so you spend your time deciding, not copying and pasting.

Primarily redraft, with Best Ball and a little DFS along for the ride.

## 2. Problem

Today this lives in screenshots, spreadsheets, and manual copy/paste:

- **Rankings toil** — collecting rankings from several rankers, normalizing player names across sites, and hand-meshing them in Excel to get your personal blend.
- **Scattered draft data** — mock and Best Ball results (mostly Yahoo + Underdog) and ADP live on other platforms with no central store or way to query them.

All22 replaces the manual Excel workflow with a central system that ingests, normalizes, stores, models, and answers questions.

## 3. Principles

- **You're the only user.** Optimize for your speed, not generality.
- **One-click and fast beats pretty.** Graphics are low priority; getting clean data in is the point.
- **Use the best tool, reuse patterns where they genuinely fit.** Some of your proven habits (append-only raw, review-queue confirms) carry over; the backend does not — this app's relational + time-series needs point to a real database (see §4).
- **Suggest, don't auto-decide.** Where the system infers something (a name match, a tier boundary), surface it for a quick confirm rather than silently committing — same review-queue philosophy as the Drop Pipeline.
- **Tweak in the app, not in code.** Every dial lives in a control panel, not a source edit.
- **Always show freshness.** Every dataset states how current it is.

## 4. Architecture decision (settled)

**Separate single-file sub-apps, unified by the hub shell, over one shared Supabase backend.** Not a monolith.

The only real case for a monolith was that the features share so much data (players, rankings, ADP interlock) that splitting them risks duplicating shared logic — but that problem lives at the *data* layer, and it disappears when the shared data sits in a proper backend every sub-app reads from. Against that, a single giant HTML file in the browser editor with no build step would be miserable to edit and risky to touch. So: separate front ends, thin, each reading/writing one shared database.

## 5. System of record & the linchpin data model

**System of record:** Supabase (managed Postgres). Schema edited in the Supabase web dashboard (no terminal); every single-file front end reads/writes via the auto-generated REST API with plain `fetch`. This is what makes the separate-apps architecture work — one shared source of truth, thin front ends, no duplicated logic — and it handles the relational joins and time-series queries (risers/fallers week-over-week) that a spreadsheet does badly.

**The linchpin is `players_master`.** Everything — rankings, ADP, draft picks — joins on one canonical `player_id`. Each site (Yahoo, Underdog, FantasyPros, FanDuel, ESPN) names players differently, so a per-site **alias map** resolves incoming names to the canonical ID. If normalization isn't rock-solid, nothing downstream is trustworthy.

Core tables:
- `players_master` — canonical id, name, position, team, aliases-by-site
- `rankings_raw` — every ingested ranking row, as captured, with source + date + **native scoring format**
- `rankings_normalized` — raw joined to canonical player_id
- `my_rankings` — output of your custom model per run
- `adp_history` — daily ADP snapshots per site
- `drafts` — mock/Best Ball/real draft picks, per draft + slot
- `notes` — scratchpad entries
- `settings` — control-panel values (ranker weights, outlier rules, etc.)

## 6. Functional scope by sub-app

> **Proposed mapping — confirm or reassign.** These are my best fit of your intent doc onto your existing app names. Move things around freely.

| Sub-app | Owns | Priority |
|---|---|---|
| **Combine** | Rankings hub: ingest, OCR, normalize, store, **custom ranking model + dials** | **#1 — build first** |
| **War Room** | Draft strategy: automated mock using your rankings, who/when/position, % available, auction strategy | 2 |
| **Playbook** | Mock/Best Ball ingestion + draft analysis (Draft Wizard–style) | 3 |
| **Edge Rush** | ADP intelligence: daily scrape (Yahoo, Underdog, ESPN), risers/fallers, freshness | 4 |
| **Hub shell** | Launcher/nav, data-health dashboard, global settings | continuous |
| **Notes** | Fast scratchpad ("that's interesting"), jot-now-research-later | lightweight, always available |

### Combine — rankings hub (the #1 job)
- Ingest rankings from 2–4 sources: **screenshots → OCR (primary)**, FantasyPros CSV/export, and web pages with FantasyPros applets.
- Store every set with **source + date + scoring format** (see §12 — format tagging is mandatory).
- Analysis: compare rankers to each other and to "the field," and compare new vs. old sets across dates to surface **risers/fallers vs. consensus ADP**.
- **Custom ranking model** (like FantasyPros ECR, but a handful of rankers with extra dials) — see §8.
- Answer questions like "biggest risers/fallers between last week and this week" or "who is Ranker #1 highest on vs. the field" (see §9).

### War Room — draft strategy
- Automated mock draft using *your* rankings + ADP to answer who to take, when, and at what position — including the **% chance a player is still available** at your next pick.
- Auction strategy variant (your done-criteria calls this out explicitly).

### Playbook — draft ingestion & analysis
- Capture drafts from Yahoo, Underdog, FantasyPros, and (lightly) FanDuel.
- Store for query; analyze a specific draft the way Draft Wizard's Analyze Draft does (value vs. ADP, reaches/steals, positional balance).

### Edge Rush — ADP intelligence
- Scrape overall ADP from Yahoo, Underdog, ESPN on a daily cadence; store snapshots.
- Feed risers/fallers detection; drive the freshness indicators.

### Hub shell
- Card launcher into each sub-app (the v0.1 spec).
- **Data-health dashboard:** per-dataset freshness + basic sanity checks ("rankings last updated 3d ago," "ADP scrape failed yesterday").
- **Global settings** panel.

## 7. Ingestion & OCR

- **Screenshots (primary):** image → Claude vision → structured JSON → Sheets via Apps Script. This is the "top-notch imaging" requirement; Claude's vision handles ranking-screenshot OCR well. Can run in-artifact ("Claude in Claude") so no server is needed for on-demand parsing.
- **CSV / FantasyPros export:** parse client-side, map columns, normalize, append.
- **Web-page applets:** where a clean export exists, use it; otherwise a **bookmarklet reads the rendered DOM** and posts rows to a Sheets catcher — the exact Drop Pipeline trick.
- **Every ingest** runs names through the alias map and routes low-confidence matches to a review queue instead of guessing.

## 8. The custom ranking model

Blend a handful of base rankings into your personal set, with these dials (all in the control panel, no code edits):

- **Per-ranker weighting** — trust one ranker more than another.
- **Outlier tamping** — if most rankers have a player top-5 but one has him at 100, damp that outlier's pull (e.g., trimmed mean, or weight-by-distance-from-median). Make the aggressiveness a dial.
- **Target league scoring** — a dial that sets *your* league's exact rules (half-PPR, TE premium, superflex, etc.) as the model's output target. This sets what your rankings are *for*; it does **not** rewrite an input's native format (a source's published PPR list stays PPR). Each input carries its native format as metadata so the model knows what it's blending.
- Output = `my_rankings`, versioned by run date so you can diff your own rankings over time too.

> **Cross-format caveat (open — see §17):** blending inputs of different native formats (standard into PPR, 1QB into superflex) isn't a naive average — it needs an adjustment step, and doing it *exactly* needs projection-level points-per-stat data. Pragmatic v1: pull each source at the format closest to your league, then let weighting/tweaks close the gap. The exact approach is worth a dedicated deep session before Phase 2.

## 9. Natural-language Q&A

A query surface (start in-app via the Anthropic API) that reads the normalized Supabase data and answers questions in plain English: risers/fallers, "who is Ranker X highest on," "where does my model disagree most with ADP." Keep it read-only over the stored tables.

## 10. Outputs & exports

- Your personal tweaked consensus rankings (`my_rankings`).
- A draft/auction strategy derived from your rankings + ADP.
- **Export rankings** in a format you can feed into Underdog (and similar).

## 11. Control panel & data health

- **Control panel:** every tweakable — ranker weights, outlier settings, sources, scrape cadence — editable in the front end, persisted to the `settings` table.
- **Data-health dashboard:** freshness per dataset (rankings, ADP, model output) and lightweight sanity checks. No heavy auditing or recovery — it's fantasy data — but you should never wonder whether something is stale.

## 12. Tech stack (settled)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Single-file HTML per sub-app, GitHub Pages, hub shell to tie together | No build step, browser-editor friendly |
| System of record | **Supabase (managed Postgres)** | Real relational + time-series store; web-dashboard schema editing (no terminal); auto REST API for every front end |
| OCR + parsing + Q&A | Claude via Anthropic API, called from the front end | No server needed for on-demand work; strong vision OCR |
| Daily ADP scrape | **Railway Node service** (later phase) | GitHub Pages can't run continuous/scheduled jobs |
| Name normalization | `players_master` + per-site alias map in Postgres | One canonical id everything joins to |

**Open stack question to vet (§17):** how to get draft data *out* of Yahoo/Underdog.

## 13. Suggested rules & edge cases

You said you couldn't think of any — here are the ones that will bite if unhandled:

- **Scoring format is identity, but it's the *input's* identity.** PPR vs. half vs. standard vs. Best Ball vs. superflex rankings aren't directly comparable. Tag every input with its native format; your model has a separate **target-scoring** dial (§8) for what your output is *for*. Blending mismatched inputs needs an adjustment, not a naive average (§17).
- **Name collisions & new players** — same-name players, rookies not yet in `players_master`, and team defenses/kickers naming quirks. Route unknowns to the review queue.
- **Mid-season team changes / trades** — a player's team can change; store team as of the snapshot date.
- **"Unranked" ≠ "ranked last"** — decide whether a ranker omitting a player means "no opinion" or "very low." This materially changes the model.
- **Tiers vs. straight ranks** — some rankers publish tiers, not ordinals. Decide how tiers map into the blend.
- **OCR format drift** — when a ranker changes their screenshot layout, OCR mapping can silently break; the data-health checks should catch obvious breakage (e.g., row count way off).

## 14. Done criteria ("It is working when I can…")

1. Quickly input other people's rankings, apply my model with my tweaks, and generate a custom set of rankings for me.
2. Quickly input, manage, and review my mock/Best Ball drafts.
3. Easily generate a suggested draft *or auction* strategy from my rankings and ADP.

## 15. Out of scope / do crudely

- Polished graphics/visual design — data-first, plain is fine.
- Heavy auditing, versioned recovery, backups beyond what Supabase gives for free.
- Multi-user anything.

## 16. Phasing

Per your instruction, the **#1 job ships first and must be genuinely one-click**:

- **Phase 0 — Foundation.** Supabase schema, the shared data-access pattern, hub-shell skeleton, and project docs (CLAUDE.md, phased session plan, TODO.md seed).
- **Phase 1 — Combine, one-click rankings ingestion.** Screenshot → OCR → normalize against `players_master` → write to Supabase → see the set. This alone kills most of the Excel toil.
- **Phase 2 — Custom model + dials.** Weighting, outlier tamping, `my_rankings` output, risers/fallers, export to Underdog.
- **Phase 3 — Playbook.** Draft ingestion + Draft Wizard–style analysis.
- **Phase 4 — Edge Rush.** Daily ADP scrape (Railway) + freshness feeding risers/fallers.
- **Phase 5 — War Room.** Draft/auction strategy simulator with % availability.
- **Throughout — Hub shell + Notes + data-health** grow alongside.

## 17. Open decisions to vet

1. **Sub-app mapping (§6)** — confirm which functional area lives in which named app.
2. **Cross-format blending** *(deep-session candidate)* — how to adjust when inputs' native formats differ; exact approach needs projection-level data.
3. **Model aggregation method** *(deep-session candidate)* — trimmed mean vs. weighted median vs. normalize-then-blend.
4. **% availability math** *(deep-session candidate)* — the draft simulator needs an ADP *distribution*, not just mean ADP.
5. **Getting draft data out of Yahoo/Underdog** — bookmarklet on the rendered board, screenshot→OCR, or export. Which platforms first?
6. **"Unranked" semantics** — no-opinion vs. ranked-last.
7. **Tiers** — how (or whether) to fold tier-based rankings into the numeric blend.
8. **Same-tab vs. new-tab** launching from the hub.

*Deep-session candidates (2–4)* are modeling-correctness questions where a plausible-but-wrong default quietly corrupts your rankings — worth a dedicated session with your most capable model before Phase 2, rather than a quick pick now.

---
## Claude Code handoff prompt

The finalized, paste-ready kickoff prompt lives in its own file: **`all22-claude-code-kickoff.md`**. It's self-contained (Supabase, separate-apps, Plan-Mode start, foundation + Phase 1, and the flagged open decisions) — hand that to Claude Code directly.
