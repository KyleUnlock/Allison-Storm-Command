'use strict';

/**
 * lib/ledger.js — tamper-evident, hash-chained event ledger.
 *
 * Every entry stores `prevHash` (hash of the entry before it) and its own
 * `hash` = sha256( prevHash + LEDGER_SECRET + canonicalJSON(payload) ).
 * Because each hash folds in the prior hash, altering any past entry breaks
 * the chain from that point forward, which verifyChain() detects.
 *
 * KV key: "ledger" (a list, oldest -> newest) via lib/store listPush/listRange.
 */

const crypto = require('crypto');
const store = require('./store');

const GENESIS = '0'.repeat(64);
const LEDGER_KEY = 'ledger';

function secret() {
  return process.env.LEDGER_SECRET || 'local-ledger-secret';
}

// Deterministic JSON: sort keys so hashing is stable.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

function hashEntry(prevHash, payload) {
  return crypto
    .createHash('sha256')
    .update(prevHash + secret() + canonical(payload))
    .digest('hex');
}

/**
 * Append an event. `payload` should be a plain object describing the event
 * (type, leadId, actor, at, data). Returns the stored entry.
 */
async function append(payload) {
  const chain = await store.listRange(LEDGER_KEY);
  const prevHash = chain.length ? chain[chain.length - 1].hash : GENESIS;
  const body = { ...payload, at: payload.at || new Date().toISOString() };
  const entry = { prevHash, payload: body, hash: hashEntry(prevHash, body) };
  await store.listPush(LEDGER_KEY, entry);
  return entry;
}

async function all() {
  return store.listRange(LEDGER_KEY);
}

/**
 * Recompute every link. Returns { valid, brokenAt } where brokenAt is the
 * index of the first tampered/broken entry, or -1 when the chain is intact.
 */
function verifyChain(chain) {
  let prevHash = GENESIS;
  for (let i = 0; i < chain.length; i += 1) {
    const e = chain[i];
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i };
    if (hashEntry(prevHash, e.payload) !== e.hash) return { valid: false, brokenAt: i };
    prevHash = e.hash;
  }
  return { valid: true, brokenAt: -1 };
}

async function verify() {
  return verifyChain(await all());
}

module.exports = { append, all, verify, verifyChain, hashEntry, canonical, GENESIS };
