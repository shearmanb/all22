# All22 — Claude Code Kickoff

> Paste everything below into Claude Code. It's self-contained. Fill the one bracketed line in Phase 1.

---

## What we're building

All22 is my single-user fantasy football nerve center: ingest other people's rankings, mesh them into my own custom-weighted rankings, track and analyze my mock + Best Ball drafts, and pull fresh ADP. Redraft-first, with Best Ball and a little DFS.

## Architecture (locked)

- **Separate single-file HTML apps — one per surface — unified by a hub-shell launcher. NOT one monolith.** The sub-apps are Combine (rankings), War Room (draft strategy), Playbook (draft analysis), Edge Rush (ADP). Only Combine gets built now.
- **Shared backend: Supabase (managed Postgres), the single system of record.** Every front-end app reads/writes the same normalized data through Supabase's auto-generated REST API with plain `fetch`. I edit schema in the Supabase web dashboard — **I have no terminal.**
- Front ends deploy to **GitHub Pages**, edited in the **GitHub browser editor**. No build step, no bundler, vanilla JS, self-contained files (CDN only if unavoidable).
- **Screenshot OCR and natural-language Q&A run through the Anthropic API** called from the front end (Claude vision for OCR).
- A daily ADP scraper comes later as a **Railway Node service** (Postgres can't self-schedule) — not now.
- Mobile-first, data-first. Plain beats pretty; I don't care about graphics.

## How I work

I'm a vibe coder — I validate by outcome, not by reading code. Explain choices in plain English tied to All22. **Start in Plan Mode:** lay out the foundation + Phase 1 plan and let me approve before you build anything.

---

## Step 1 — Foundation

1. Design the Supabase schema (below) and set it up.
2. Establish the shared data-access pattern every sub-app will reuse (how a single-file front end talks to Supabase).
3. Scaffold the hub-shell launcher: cards linking to each sub-app, a data-health / freshness panel, and a global settings area. Only Combine needs to be live.
4. Generate my standard project docs: a **CLAUDE.md** (stack, conventions, the no-terminal / browser-editor constraints, the Supabase access pattern), a **phased session plan**, and a **TODO.md** seed.

### Supabase schema

- `players_master` — canonical `player_id`, name, position, team, plus a per-site alias map (Yahoo / Underdog / FantasyPros / FanDuel / ESPN). This is the linchpin: everything joins to it.
- `rankings_raw` — one row per ranked player, as captured: `source`, `ingested_at`, and `native_scoring_format` (`ppr | half | standard | best_ball | superflex`). This is the format the source was **published in** — never alter it.
- `rankings_normalized` — `rankings_raw` joined to canonical `player_id`.
- `my_rankings` — output of my custom model, versioned by run (later phase; create the table).
- `adp_history` — daily ADP snapshots per site (later phase; create the table).
- `drafts` — mock / Best Ball / real picks per draft + slot (later phase; create the table).
- `notes` — scratchpad entries.
- `settings` — control-panel values.

---

## Step 2 — Phase 1: Combine, one-click rankings ingestion (BUILD THIS)

**The one job:** I upload or paste a screenshot of someone's rankings → one click → it's OCR'd into structured rows → normalized against `players_master` → written to Supabase → shown back to me. Make this genuinely one-click and fast; it's the whole point of Phase 1.

Requirements:

- Every set is tagged on the way in with `source`, `date`, and `native_scoring_format`.
- OCR output is matched to `players_master` by name/alias. Confident matches write through; **low-confidence or unknown names go to a visible review queue** for me to confirm or add to `players_master`. Never silently guess a player's identity.
- A small settings area (writes to `settings`). No editing code to tweak things.
- Seed `players_master` from [a CSV I'll provide / generate a starter list for me].
- Mobile-first, fast, plain.

---

## Do NOT build yet (later phases)

Design the schema so these aren't blocked, but don't build them now:

- **Custom ranking model + dials** (Phase 2): per-ranker **weighting**, **outlier tamping**, and — importantly — **my target league scoring as a dial** (half-PPR, TE premium, superflex, etc.). Note: the dial sets the *model's output* target; it does **not** rewrite an input's native format.
- **Playbook** — draft ingestion + Draft Wizard–style analysis.
- **Edge Rush** — daily ADP scrape (Railway).
- **War Room** — draft + auction strategy simulator with % availability.

---

## Decisions I have NOT settled — surface these in your plan; do not silently pick

1. **Cross-format blending.** Inputs arrive in different native formats. Naively averaging a standard list with a PPR list is wrong. Flag how you'd handle it, and where a real adjustment is needed vs. the pragmatic "pull each source at the format closest to my league, then let my weighting close the gap."
2. **Model aggregation method** — trimmed mean vs. weighted median vs. normalize-then-blend. Different rankers have different scales and behavior.
3. **"Unranked" semantics** — does a ranker omitting a player mean "no opinion" or "ranked last"? It changes the model materially.
4. **Tiers vs. ordinals** — how tier-based rankings fold into a numeric blend.
5. **Getting draft data out of Yahoo / Underdog** — bookmarklet reading the rendered draft board vs. screenshot→OCR vs. manual export.

For #1 and #2 especially: keep the Phase 1 schema flexible, but flag that the *modeling* decision deserves a dedicated deep session before Phase 2 rather than a quick default now.
