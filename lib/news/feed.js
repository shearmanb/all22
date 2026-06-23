// Minimal, dependency-free RSS 2.0 / Atom 1.0 feed parser.
//
// The news aggregator only needs a handful of fields per article: a title,
// a link, a publish date, a short text summary, and a stable id used to
// de-duplicate items across refreshes. Feeds in the wild are messy, so this
// parser is deliberately tolerant — it extracts what it can and skips the
// rest rather than throwing. We do NOT pull a full XML library in (the app
// keeps its dependency list tiny); regex extraction is enough for the small,
// well-shaped set of fields we care about.

// Decode the handful of XML/HTML entities that actually show up in feed text.
function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    // Ampersand last so we don't double-decode the entities above.
    .replace(/&amp;/g, '&');
}

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

// Strip a CDATA wrapper if present, e.g. <![CDATA[ ... ]]>.
function stripCdata(str) {
  if (!str) return '';
  const m = str.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1] : str;
}

// Strip HTML tags and collapse whitespace — feed summaries are often HTML,
// but the homepage list only wants a plain-text teaser.
function stripTags(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Return the trimmed inner text of the first matching tag inside `block`.
// `names` may be a single tag name or several alternatives (first wins).
function firstTagText(block, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const re = new RegExp(`<${escapeTag(name)}\\b[^>]*>([\\s\\S]*?)</${escapeTag(name)}>`, 'i');
    const m = block.match(re);
    if (m) return decodeEntities(stripCdata(m[1])).trim();
  }
  return '';
}

// Return the value of `attr` on the first occurrence of `<tag ...>` in block.
function firstTagAttr(block, tag, attr) {
  const re = new RegExp(`<${escapeTag(tag)}\\b([^>]*)>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  const am = m[1].match(new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, 'i'));
  return am ? decodeEntities(am[1]).trim() : '';
}

// Tag names can contain a namespace colon (dc:creator, content:encoded);
// the colon is literal in a regex, but escape just in case the source list
// ever grows.
function escapeTag(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseDate(str) {
  if (!str) return null;
  const t = Date.parse(str.trim());
  return Number.isNaN(t) ? null : new Date(t);
}

// Pull the best link out of an Atom <entry>. Atom links are attributes:
// prefer rel="alternate" (the human-readable page), never rel="self"/"edit".
function atomLink(block) {
  const links = block.match(/<link\b[^>]*>/gi) || [];
  let fallback = '';
  for (const tag of links) {
    const rel = (tag.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1] || 'alternate';
    const href = (tag.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (!href) continue;
    if (rel === 'alternate') return decodeEntities(href).trim();
    if (rel !== 'self' && rel !== 'edit' && !fallback) fallback = decodeEntities(href).trim();
  }
  return fallback;
}

function trimSummary(text, max = 280) {
  const clean = stripTags(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max - 1).trimEnd() + '…';
}

// Parse a raw feed (XML string) into a normalized array of items, newest
// kept in feed order. Returns [] for anything unparseable.
function parseFeed(xml, { max = 25 } = {}) {
  if (!xml || typeof xml !== 'string') return [];

  const isAtom = /<feed\b[^>]*>/i.test(xml) && /<entry\b/i.test(xml);
  const blockRe = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
    : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  const items = [];
  let m;
  while ((m = blockRe.exec(xml)) !== null && items.length < max) {
    const block = m[1];

    const title = firstTagText(block, 'title');
    const url = isAtom
      ? atomLink(block)
      : (firstTagText(block, 'link') || guidAsLink(block));

    // Skip entries with neither a title nor a link — nothing to show.
    if (!title && !url) continue;

    const rawSummary = isAtom
      ? firstTagText(block, ['summary', 'content'])
      : firstTagText(block, ['description', 'content:encoded']);

    const author = isAtom
      ? (firstTagText(block, 'name') || firstTagText(block, 'author'))
      : firstTagText(block, ['dc:creator', 'author']);

    const dateStr = isAtom
      ? (firstTagText(block, ['published', 'updated']))
      : (firstTagText(block, ['pubDate', 'dc:date', 'published']));

    const guid = isAtom
      ? (firstTagText(block, 'id') || url || title)
      : (firstTagText(block, 'guid') || url || title);

    items.push({
      guid: guid.trim(),
      title: title.trim(),
      url: (url || '').trim(),
      summary: trimSummary(rawSummary),
      author: author.trim(),
      publishedAt: parseDate(dateStr),
    });
  }
  return items;
}

// RSS feeds sometimes omit <link> but carry a permalink guid.
function guidAsLink(block) {
  const tag = (block.match(/<guid\b[^>]*>([\s\S]*?)<\/guid>/i) || [])[0] || '';
  if (/ispermalink\s*=\s*["']false["']/i.test(tag)) return '';
  const val = firstTagText(block, 'guid');
  return /^https?:\/\//i.test(val) ? val : '';
}

module.exports = { parseFeed, decodeEntities, stripTags, trimSummary };
