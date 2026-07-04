'use strict';

/**
 * scripts/preflight.js — go-live fence assertion (`npm run preflight`).
 *
 * Asserts that every REQUIRED fence env NAME is present before deploy, and
 * WARNs (non-fatal) on the optional/ship-dark ones. It NEVER prints a value —
 * only the NAME and a present/missing verdict — and it never mutates anything
 * or bypasses a gate; it only reports whether the fences are configured.
 *
 * It also runs ledger.verifyChain() when a store is reachable and prints the
 * integrity badge. Missing KV is not an error here (in-memory fallback answers
 * an empty chain, which verifies as valid); a live-but-broken chain is flagged
 * loudly but does not by itself fail preflight — the badge is informational.
 *
 * Exit code: non-zero if any REQUIRED var is missing; zero otherwise.
 * Pure/offline-safe — never throws on missing KV.
 */

const ledger = require('../lib/ledger');
const store = require('../lib/store');

// REQUIRED: go-live is blocked until these are set in the deploy environment.
const REQUIRED = [
  { name: 'SESSION_SECRET', why: 'HMAC secret for operator/rep sessions' },
  { name: 'LEDGER_SECRET', why: 'HMAC secret for the tamper-evident ledger' },
  { name: 'KV_REST_API_URL', why: 'Upstash/Vercel KV REST endpoint' },
  { name: 'KV_REST_API_TOKEN', why: 'Upstash/Vercel KV REST token' },
  { name: 'BOARD_PASSWORD', why: 'operator gate for /board, /crm, /report' },
];

// OPTIONAL / ship-dark: WARN if missing, never block. Each fails CLOSED in
// code when unset, so absence is safe (feature simply stays dark).
const OPTIONAL = [
  { name: 'REP_CREDENTIALS', why: 'rep login map — no reps can sign in until set' },
  { name: 'DNC_PROVIDER', why: 'DNC scrub provider — unset ⇒ cold leads withheld (safe)' },
  { name: 'DNC_API_KEY', why: 'DNC provider API key — pairs with DNC_PROVIDER' },
  { name: 'CRON_SECRET', why: 'gates api/storm-import — unset ⇒ scheduled import closed' },
  { name: 'META_APP_SECRET', why: 'Meta webhook signature — unset ⇒ webhook fails closed' },
  { name: 'META_VERIFY_TOKEN', why: 'Meta subscription handshake token' },
  { name: 'CALLRAIL_SIGNING_KEY', why: 'CallRail/LSA webhook HMAC — unset ⇒ fails closed' },
  { name: 'RESEND_API_KEY', why: 'internal notify transport — unset ⇒ notify no-ops' },
  { name: 'NOTIFY_TO', why: 'internal operator notify recipient(s)' },
  { name: 'REP_TERRITORIES', why: 'territory routing — unset ⇒ pure round-robin' },
  { name: 'SLA_FIRST_TOUCH_MINUTES', why: 'first-touch SLA threshold — unset ⇒ default 60' },
];

function isSet(name) {
  const v = process.env[name];
  return typeof v === 'string' && v.trim() !== '';
}

async function main() {
  const missingRequired = [];

  console.log('preflight — fence env assertion (names only, no values printed)\n');

  console.log('REQUIRED:');
  for (const { name, why } of REQUIRED) {
    if (isSet(name)) {
      console.log(`  ok   ${name} — set (${why})`);
    } else {
      missingRequired.push(name);
      console.error(`  MISS ${name} — MISSING (${why})`);
    }
  }

  console.log('\nOPTIONAL (ship-dark; fail-closed when unset):');
  for (const { name, why } of OPTIONAL) {
    if (isSet(name)) {
      console.log(`  ok   ${name} — set (${why})`);
    } else {
      console.warn(`  warn ${name} — not set (${why})`);
    }
  }

  // Ledger integrity badge — informational, never throws on missing KV.
  console.log('\nLEDGER INTEGRITY:');
  try {
    const chain = await store.listRange('ledger');
    const result = ledger.verifyChain(chain);
    if (result.valid) {
      console.log(`  ok   ledger valid (${chain.length} entr${chain.length === 1 ? 'y' : 'ies'})`);
    } else {
      console.error(`  BROKEN ledger chain — first break at index ${result.brokenAt}`);
    }
  } catch {
    // Never echo the error message — it can embed the KV URL/token value.
    console.log('  unknown — store unreachable, integrity not checked');
  }

  console.log('');
  if (missingRequired.length > 0) {
    console.error(
      `preflight FAILED — ${missingRequired.length} required var(s) missing: ${missingRequired.join(', ')}`
    );
    process.exit(1);
  }
  console.log('preflight OK — all required fence vars present.');
}

main().catch((e) => {
  // A crash must not read as a green preflight.
  console.error(`preflight ERROR — ${e.message}`);
  process.exit(1);
});
