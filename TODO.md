# All22 — To-Do / Follow-ups

Open items deferred for later (not blocking; everything below is live on Railway).

## Rankings Converter

- [ ] **Nickname alias table.** The fuzzy name matcher (`lib/players.js` `findName`)
  handles OCR noise, missing spaces, suffixes, and short/long first names, but it
  anchors on the last name — so true nicknames where the first name is completely
  different AND the last name is common don't auto-resolve (e.g. "Hollywood Brown"
  → Marquise Brown). For now the fix queue covers these. Add a small curated
  alias map (alias → canonical name) seeded with the well-known ones and consulted
  during roster lookup.

- [ ] **Verify Underdog & Yahoo export columns.** Both converters
  (`features/rankings-converter/lib/converters/underdog.js`, `yahoo.js`) are
  flagged `verified: false` ("verify columns"). Download a current template/CSV
  from each site, confirm the header row matches what we emit, then flip
  `verified` to `true` (and adjust the COLUMNS line if needed). The plain CSV and
  FantasyPros exports are already verified.
