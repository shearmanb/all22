// Feature registry — the single place that lists the portal's applets.
// To add a new applet: create features/<name>/ (with a router.js and a public/
// folder), then add one entry here. No existing feature's code is touched.
//
// Each entry:
//   name      machine name (folder)
//   label     human label (for the hub launcher)
//   apiMount  base path its router is mounted at (e.g. '/api/combine')
//   router    the express Router for its /api endpoints
//   publicDir absolute path to its static pages (served at the site root)
//
// PRD sub-apps not yet built (War Room — draft strategy, Edge Rush — ADP
// intelligence) appear on the hub as "coming soon" cards until they land here.
const path = require('path');

module.exports = [
  {
    name: 'combine',
    label: 'Combine',
    apiMount: '/api/combine',
    router: require('./combine/router'),
    publicDir: path.join(__dirname, 'combine', 'public'),
  },
  {
    name: 'playbook',
    label: 'Playbook',
    apiMount: '/api/drafts',
    router: require('./playbook/router'),
    publicDir: path.join(__dirname, 'playbook', 'public'),
  },
  {
    name: 'notes',
    label: 'Notes',
    apiMount: '/api/notes',
    router: require('./notes/router'),
    publicDir: path.join(__dirname, 'notes', 'public'),
  },
];
