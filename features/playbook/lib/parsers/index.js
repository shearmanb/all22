// Parser registry: add new sites here as separate files.
const parsers = {
  underdog: require('./underdog'),
  fantasypros: require('./fantasypros'),
  // yahoo: require('./yahoo'),    // Phase 6
  // sleeper: require('./sleeper'),
};

function parse(site, text, opts) {
  const key = (site || '').toLowerCase();
  const parser = parsers[key] || parsers.underdog;
  return parser.parse(text, opts);
}

module.exports = { parse, parsers };
