const express = require('express');
const news = require('../lib/news');

const router = express.Router();
const hasDb = () => Boolean(process.env.DATABASE_URL);

// GET /api/news — cached headlines grouped by source. Triggers a background
// refresh of any stale source first, but never fails the page if a refresh
// errors (the per-source status carries that to the UI instead).
router.get('/', async (req, res) => {
  try {
    try {
      await news.refreshIfStale();
    } catch (err) {
      console.error(`GET /api/news: stale refresh failed: ${err.message}`);
    }
    const data = await news.getNews();
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`GET /api/news: ${err.message}`);
    res.json({ ok: false, error: 'Failed to load news.' });
  }
});

// POST /api/news/refresh — force-refresh every feed now (the Refresh button).
router.post('/refresh', async (req, res) => {
  try {
    await news.refreshAll();
    const data = await news.getNews();
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`POST /api/news/refresh: ${err.message}`);
    res.json({ ok: false, error: 'Failed to refresh news.' });
  }
});

// GET /api/news/sources — the owner's configured source list (Settings panel).
router.get('/sources', async (req, res) => {
  try {
    res.json({ ok: true, data: await news.getSources() });
  } catch (err) {
    console.error(`GET /api/news/sources: ${err.message}`);
    res.json({ ok: false, error: 'Failed to load news sources.' });
  }
});

// PUT /api/news/sources — save the edited source list. Body: { sources: [...] }.
// Validation errors are returned verbatim so they show in the UI banner.
router.put('/sources', async (req, res) => {
  try {
    if (!hasDb()) return res.status(400).json({ ok: false, error: 'Settings need a database (DATABASE_URL is not set).' });
    const list = (req.body && req.body.sources) || [];
    const saved = await news.setSources(list);
    // Pull fresh headlines for any new/changed feeds so The Wire isn't empty
    // right after a save; failures surface as per-source status, not here.
    news.refreshIfStale(0).catch((e) => console.error(`PUT /api/news/sources refresh: ${e.message}`));
    res.json({ ok: true, data: saved });
  } catch (err) {
    console.error(`PUT /api/news/sources: ${err.message}`);
    res.status(400).json({ ok: false, error: err.message || 'Could not save news sources.' });
  }
});

// POST /api/news/sources/test — fetch + parse a feed URL and report what came
// back, so the owner can confirm a feed works before saving it. Does not cache.
router.post('/sources/test', async (req, res) => {
  try {
    const feedUrl = (req.body && req.body.feedUrl) || '';
    const data = await news.testFeed(feedUrl);
    res.json({ ok: true, data });
  } catch (err) {
    console.error(`POST /api/news/sources/test: ${err.message}`);
    res.json({ ok: false, error: err.message || 'Could not fetch that feed.' });
  }
});

module.exports = router;
