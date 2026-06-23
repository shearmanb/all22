const express = require('express');
const news = require('../lib/news');

const router = express.Router();

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

module.exports = router;
