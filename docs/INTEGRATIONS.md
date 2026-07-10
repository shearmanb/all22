# External data integrations — what's automatic, what's possible, what's not

_Last updated: 2026-07-10. This is the owner-facing answer sheet for "can the
app get X automatically?"._

## Working today (built, automatic)

### ADP (Edge Rush)
- **FantasyFootballCalculator** — documented free JSON API, no key, no login.
  One feed per scoring format **and league size** (their mocks run at 8/10/12/14
  teams), with pick distribution (high/low/stdev/times drafted). Updates once a
  day; the collector matches that cadence. Their terms: free for personal use,
  attribution requested (shown on the Edge Rush page).
- **Sleeper** — the projections endpoint of the same free API that seeds the
  player registry carries draft-room ADP for standard/PPR/half/2QB in one call,
  keyed by the same Sleeper IDs `players_master` stores, so joins are exact.
  Undocumented endpoint: the parser fails loudly if the shape drifts.
- Both are collected at boot + re-checked every 6h (no-op once today's
  snapshots exist). **Verify the first collection on Railway after deploy** —
  this dev sandbox couldn't reach either host (its proxy, not the APIs).

### Expert rankings (Combine → "fetch from a FantasyPros URL")
- FantasyPros embeds its full consensus payload in every public rankings page
  (`ecrData`). The fetcher pulls any `fantasypros.com/nfl/rankings/*.php` URL —
  standard/PPR/half/superflex/best-ball cheat sheets and per-position pages —
  with no login and no API key, and can re-pull daily per URL (auto-pull list
  on the Ingest tab). If FantasyPros ever blocks or changes the page, the error
  is loud and paste/CSV/screenshot remain.

## Possible, needs a decision + a one-time setup

### Yahoo live draft ("can the app watch my Yahoo draft room?")
Short answer: **yes, near-live, via the official Yahoo Fantasy Sports API —
with a one-time app registration; not verified end-to-end yet.**

- Yahoo has an official OAuth2 Fantasy Sports API. You register a (personal)
  app at developer.yahoo.com, put its client id/secret in Railway variables,
  click "connect Yahoo" once in All22, and the server keeps a refresh token.
- The league's `draftresults` endpoint
  (`/fantasy/v2/league/{league_key}/draftresults?format=json`) can then be
  polled during your draft (every ~15–30s is polite). Community experience is
  that results populate while a live draft is running, with a small delay —
  good enough for "who's gone / who's left" against My Rankings, not for
  split-second sniping. **Caveat: I could not re-verify live-draft behavior
  this session (research task hit a limit); treat "updates mid-draft" as
  probable, not certain, until we test it in a Yahoo mock room.**
- A true real-time hook into the draft-room websocket is private/undocumented —
  fragile, not worth building on.
- **Plan-B that always works:** a bookmarklet in the draft-room tab that reads
  the rendered board and POSTs picks to Playbook every few seconds (the proven
  Drop-Pipeline trick, and PRD §17.5's suggestion). No API, no OAuth, immune to
  API delay questions.
- Recommendation: build the bookmarklet first (small, certain), add the OAuth
  polling path after a mock-draft test proves `draftresults` is live enough.

### Underdog
No public API for your drafts. Their ADP is technically reachable without
login but Cloudflare-fronted and fragile — skipped for now (FFC + Sleeper
cover ADP). Draft capture stays paste/CSV (and the Underdog-with-IDs export
already handles the upload direction).

## About logins and passwords
Subscription rankings (Fantasy Points, etc.) could be scripted with stored
credentials, but storing a password in the app is the worst option: sites
rotate bot defenses, logins from a Railway IP can trip security alerts, and it
usually violates the site's terms. Better options, in order:
1. **Sites with public pages** (FantasyPros): the URL fetcher — already built.
2. **Sites with CSV export**: keep using Combine's CSV import (10 seconds).
3. **Subscription sites**: a bookmarklet that captures the rendered rankings
   page in your logged-in browser and POSTs it to Combine — no credentials
   ever leave your browser. Say the word and it gets built.
