'use strict';

/**
 * api/health.js — PUBLIC, side-effect-free liveness/readiness probe.
 *
 * Returns { ok:true, ts, checks:{ store, ledger } } and NOTHING else — no
 * secrets, no env values, no lead data, no PII. It only probes whether the KV
 * store is reachable and whether the hash-chained ledger verifies; it never
 * mutates state, never sends anything, and never bypasses a gate.
 *
 *   checks.store   : 'up'   KV read succeeded (or in-memory fallback answered)
 *                    'down' the read threw
 *   checks.ledger  : 'valid'   ledger.verifyChain() intact
 *                    'broken'  chain tamper / truncation detected
 *                    'unknown' store unreachable, so integrity is unknowable
 *   checks.backend : 'kv'      real Upstash/Vercel KV is configured
 *                    'memory'  the volatile in-memory fallback is in use
 *   checks.degraded: true when running in PRODUCTION on the memory fallback —
 *                    every inbound lead is silently lost across cold starts.
 *                    Monitoring should alert on this even though ok stays true.
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
    // Head-aware so a tail truncation (which leaves a consistent prefix) is
    // caught, not just an in-place tamper. An absent head is treated as
    // unanchored, so pre-existing ledgers never false-alarm.
    const result = ledger.verifyChain(chain, await ledger.head());
    ledgerState = result.valid ? 'valid' : 'broken';
  } catch {
    storeUp = false;
    ledgerState = 'unknown';
  }

  const inProd = Boolean(
    process.env.VERCEL || process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production'
  );

  return sendJson(res, 200, {
    ok: true,
    ts: new Date().toISOString(),
    checks: {
      store: storeUp ? 'up' : 'down',
      ledger: ledgerState,
      backend: store.LIVE ? 'kv' : 'memory',
      degraded: inProd && !store.LIVE,
    },
  });
};
