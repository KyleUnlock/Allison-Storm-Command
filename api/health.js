'use strict';

/**
 * api/health.js — PUBLIC, side-effect-free liveness/readiness probe.
 *
 * Returns { ok:true, ts, checks:{ store, ledger } } and NOTHING else — no
 * secrets, no env values, no lead data, no PII. It only probes whether the KV
 * store is reachable and whether the hash-chained ledger verifies; it never
 * mutates state, never sends anything, and never bypasses a gate.
 *
 *   checks.store  : 'up'   KV read succeeded (or in-memory fallback answered)
 *                   'down' the read threw
 *   checks.ledger : 'valid'   ledger.verifyChain() intact
 *                   'broken'  chain tamper detected
 *                   'unknown' store unreachable, so integrity is unknowable
 */

const store = require('./../lib/store');
const ledger = require('./../lib/ledger');
const { sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  let storeUp = false;
  let ledgerState = 'unknown';
  try {
    // A read-only probe. listRange on the ledger key both confirms the store
    // answers AND gives us the chain to verify — one round-trip, no writes.
    const chain = await store.listRange('ledger');
    storeUp = true;
    const result = ledger.verifyChain(chain);
    ledgerState = result.valid ? 'valid' : 'broken';
  } catch {
    storeUp = false;
    ledgerState = 'unknown';
  }

  return sendJson(res, 200, {
    ok: true,
    ts: new Date().toISOString(),
    checks: {
      store: storeUp ? 'up' : 'down',
      ledger: ledgerState,
    },
  });
};
