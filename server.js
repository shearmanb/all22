require('dotenv').config();

const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');

const { runMigrations } = require('./db/migrate');
const healthRouter = require('./routes/health');
const authRouter = require('./routes/auth');
const newsRouter = require('./routes/news');
const features = require('./features');

const app = express();

app.use(express.urlencoded({ extended: false }));
// Screenshots reach the converter as base64 data URLs in the JSON body, so the
// limit must be well above Express's 100kb default (a phone screenshot is a few MB).
app.use(express.json({ limit: '25mb' }));

app.use(cookieSession({
  name: 'all22',
  secret: process.env.COOKIE_SECRET || process.env.APP_PASSWORD || 'all22-dev-secret',
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
}));

// Unauthenticated routes: health check and login flow.
app.use(healthRouter);
app.use(authRouter);

// Static assets needed by the login page must be reachable pre-auth;
// CSS/JS contain nothing sensitive.
app.get('/app.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.css')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));

// Password gate: everything below requires a session.
app.use((req, res, next) => {
  if (req.session && req.session.authed) return next();
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ ok: false, error: 'Not logged in. Reload the page to log in.' });
  }
  res.redirect('/login');
});

// Homepage news aggregator — a core part of the splash page (not an applet),
// so it's mounted here rather than in the feature registry.
app.use('/api/news', newsRouter);

// Mount each applet from the registry: its API router + its static pages.
// Feature pages are served at the site root, so links like /drafts.html and
// /convert.html resolve directly (filenames are distinct across features).
for (const feature of features) {
  app.use(feature.apiMount, feature.router);
  app.use(express.static(feature.publicDir));
}

// Shared/core pages (splash, login) and assets.
app.use(express.static(path.join(__dirname, 'public')));

// 404s: JSON for API, simple message otherwise.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ ok: false, error: 'Not found.' });
  }
  res.status(404).send('Not found. <a href="/">Home</a>');
});

// Last-resort error handler.
app.use((err, req, res, next) => {
  console.error(`${req.method} ${req.path}: ${err.message}`);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ ok: false, error: 'Server error: ' + err.message });
  }
  res.status(500).send('Server error.');
});

const port = process.env.PORT || 3000;

async function start() {
  try {
    await runMigrations();
  } catch (err) {
    // Boot anyway so /health can report the DB problem instead of the
    // app just crash-looping on Railway.
    console.error(`startup: migrations failed: ${err.message}`);
  }
  app.listen(port, () => console.log(`all22 listening on port ${port}`));
}

start();
