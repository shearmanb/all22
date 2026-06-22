// Converter registry. Add a new output format by dropping a module in this
// folder and listing it here. Each converter exports:
//   { id, label, description, filenameBase, verified, build(players) -> csvString }
//
// The pipeline is deliberately staged so formats stay independent:
//   input (OCR/paste) -> parser -> internal list [{rank,name,position,team}] -> converter
const vanilla = require('./vanilla');
const underdog = require('./underdog');
const yahoo = require('./yahoo');
const fantasypros = require('./fantasypros');

const CONVERTERS = [vanilla, underdog, yahoo, fantasypros];
const BY_ID = Object.fromEntries(CONVERTERS.map((c) => [c.id, c]));

function list() {
  return CONVERTERS.map(({ id, label, description, verified }) => ({
    id,
    label,
    description,
    verified: verified !== false,
  }));
}

function get(id) {
  return BY_ID[id] || null;
}

module.exports = { list, get, CONVERTERS };
