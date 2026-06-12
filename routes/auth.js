const express = require('express');
const path = require('path');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session && req.session.authed) return res.redirect('/');
  res.sendFile(path.join(__dirname, '..', 'public', 'login.html'));
});

router.post('/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (!process.env.APP_PASSWORD) {
    console.error('POST /login: APP_PASSWORD env var is not set');
    return res.redirect('/login?error=config');
  }
  if (password === process.env.APP_PASSWORD) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
