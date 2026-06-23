// The sites the owner follows, in display order.
//
// `kind` decides how each source behaves on the homepage:
//   - 'rss'  : fetch `feedUrl`, parse it, and list recent articles.
//   - 'link' : no usable public feed (paywalled / SPA / no RSS) — show a
//              single "open the site" tile instead of fake content.
//
// Feed-first by design: we only list real published items where a feed
// actually exists, and link out otherwise. To promote a 'link' source to a
// real feed later, set `kind: 'rss'` and fill in a confirmed `feedUrl`.

module.exports = [
  {
    key: 'beastdome',
    name: 'BEAST DOME',
    siteUrl: 'https://www.beastdome.com/',
    // WordPress standard feed. Verified live 2026-06-22 (200, 10 items).
    feedUrl: 'https://www.beastdome.com/feed/',
    kind: 'rss',
  },
  {
    key: 'nbc-rotoworld',
    name: 'NBC · Rotoworld Player News',
    siteUrl: 'https://www.nbcsports.com/fantasy/football/player-news',
    // NBC publishes an Atom feed at <page>.atom — this is the canonical feed
    // for the exact page above. Verified live 2026-06-22 (200, valid Atom,
    // recently regenerated). Expect it to be EMPTY through the summer: player
    // news is sparse in the offseason, so the homepage shows "No recent items
    // yet." until camps open, then it fills with injury/transaction blurbs.
    feedUrl: 'https://www.nbcsports.com/fantasy/football/player-news.atom',
    kind: 'rss',
  },
  {
    key: 'fantasypoints',
    name: 'FantasyPoints',
    siteUrl: 'https://www.fantasypoints.com/',
    // Subscription single-page app; no public feed (verified 2026-06-22:
    // /feed/ returns HTML, /articles is a client-rendered SPA). Link out only.
    feedUrl: null,
    kind: 'link',
  },
];
