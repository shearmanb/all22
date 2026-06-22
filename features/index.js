// Feature registry — the single place that lists the portal's applets.
// To add a new applet: create features/<name>/ (with a router.js and a public/
// folder), then add one entry here. No existing feature's code is touched.
//
// Each entry:
//   name      machine name (folder)
//   label     human label (for the splash/launcher)
//   apiMount  base path its router is mounted at (e.g. '/api/drafts')
//   router    the express Router for its /api endpoints
//   publicDir absolute path to its static pages (served at the site root)
const path = require('path');

module.exports = [
  {
    name: 'draft-tracker',
    label: 'Draft Tracker',
    apiMount: '/api/drafts',
    router: require('./draft-tracker/router'),
    publicDir: path.join(__dirname, 'draft-tracker', 'public'),
  },
  {
    name: 'rankings-converter',
    label: 'Rankings Converter',
    apiMount: '/api/convert',
    router: require('./rankings-converter/router'),
    publicDir: path.join(__dirname, 'rankings-converter', 'public'),
  },
];
