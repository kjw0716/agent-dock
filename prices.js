'use strict';
// API list prices in USD per million tokens, used only to ESTIMATE what the tokens would cost at pay-as-you-go
// rates (a subscription or a relay bills differently). A model without a price is reported as unpriced, never as free
// (the one exception: the agent itself reported a cost for every call of it, see usage.js).
//
// Edit or extend the table in <data>/prices.json:
//   { "models": { "gpt-6.2-astra": { "in": 1.25, "out": 10, "cacheRead": 0.125 } } }
// An entry matches the exact model id, also with a "[1m]" suffix or a -YYYYMMDD date after it. A model with no entry is unpriced.
// Missing fields: cacheRead = 10% of "in", 5-minute cache write = 125% of "in", 1-hour cache write = 200% of "in",
// cacheWrite (Codex, no lifetime) = 125% of "in".
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  'claude-fable-5-2': { in: 8, out: 40, cacheRead: 0.2 },
  'claude-mythos-5-2': { in: 8, out: 40, cacheRead: 0.2 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-mythos-5-1': { in: 10, out: 50 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 }, // up to 100K-token prompts
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const clean = (id) => String(id || '').replace(/\[.*\]$/, '').toLowerCase();

function loadTable(file) {
  const table = { ...DEFAULTS };
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, p] of Object.entries((v && v.models) || {})) {
      if (p && Number.isFinite(p.in) && Number.isFinite(p.out)) table[clean(id)] = p;
    }
  } catch {}
  return table;
}

// Exact id, ignoring a "[1m]" suffix and a trailing -YYYYMMDD snapshot date. A different version (claude-opus-5-6)
// is NOT priced like a similar one: it is reported as unpriced until it has an entry.
function find(table, model) {
  const m = clean(model);
  return table[m] || table[m.replace(/-\d{8}$/, '')] || null;
}

/** price(agent, model, { i, o, cr, cw, cw1 }) -> USD, or null when the model has no price. */
function makePrice(table) {
  return (agent, model, b) => {
    const p = find(table, model);
    if (!p) return null;
    const cacheRead = Number.isFinite(p.cacheRead) ? p.cacheRead : p.in * 0.1;
    const w5 = Number.isFinite(p.cacheWrite5m) ? p.cacheWrite5m : Number.isFinite(p.cacheWrite) ? p.cacheWrite : p.in * 1.25;
    const w1 = Number.isFinite(p.cacheWrite1h) ? p.cacheWrite1h : p.in * 2;
    const cw1 = Math.min(b.cw1 || 0, b.cw || 0);
    return ((b.i || 0) * p.in + (b.o || 0) * p.out + (b.cr || 0) * cacheRead + ((b.cw || 0) - cw1) * w5 + cw1 * w1) / 1e6;
  };
}

module.exports = { DEFAULTS, loadTable, makePrice, find };
