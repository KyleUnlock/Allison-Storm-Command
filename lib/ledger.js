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
const LOCK_KEY = 'ledger:lock';
const HEAD_KEY = 'ledger:head'; // { count, hash } — tail-truncation evidence.
const LOCK_TTL_MS = 5000; // must exceed a listRange+listPush+set round-trip.
const LOCK_TRIES = 100;
const LOCK_DELAY_MS = 25;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn while holding the ledger append lock. FAIL-CLOSED: if the lock cannot
 * be acquired within the bounded spin, throw rather than append unlocked (an
 * unserialized append is exactly the race this prevents). Always released.
 */
async function withAppendLock(fn) {
  for (let i = 0; i < LOCK_TRIES; i += 1) {
    if (await store.setNx(LOCK_KEY, LOCK_TTL_MS)) {
      try {
        return await fn();
      } finally {
        await store.delLock(LOCK_KEY);
      }
    }
    await sleep(LOCK_DELAY_MS);
  }
  throw new Error('ledger: could not acquire append lock');
}

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
  // Serialize the read-tail -> push so two concurrent appends cannot both chain
  // off the same prevHash and fork the ledger (a false tamper alarm).
  return withAppendLock(async () => {
    const chain = await store.listRange(LEDGER_KEY);
    const prevHash = chain.length ? chain[chain.length - 1].hash : GENESIS;
    const body = { ...payload, at: payload.at || new Date().toISOString() };
    const entry = { prevHash, payload: body, hash: hashEntry(prevHash, body) };
    await store.listPush(LEDGER_KEY, entry);
    // Head commitment: length + head hash, so deleting trailing entries (which
    // leaves a still-internally-consistent prefix) is detectable. Best-effort —
    // a failed head write must not fail the append; it self-heals next append.
    try {
      await store.set(HEAD_KEY, { count: chain.length + 1, hash: entry.hash });
    } catch {
      /* head lags one until the next append; the entry itself is committed */
    }
    return entry;
  });
}

async function head() {
  return store.get(HEAD_KEY);
}

async function all() {
  return store.listRange(LEDGER_KEY);
}

/**
 * Recompute every link. Returns { valid, brokenAt } where brokenAt is the
 * index of the first tampered/broken entry, or -1 when the chain is intact.
 *
 * Optional `head` ({count, hash}) adds tail-truncation detection: a shorter
 * chain whose surviving prefix still verifies is caught by the length/head
 * mismatch. An absent/malformed head is treated as UNANCHORED (no truncation
 * check) so pre-existing ledgers never flip to invalid.
 */
function verifyChain(chain, head) {
  let prevHash = GENESIS;
  for (let i = 0; i < chain.length; i += 1) {
    const e = chain[i];
    if (e.prevHash !== prevHash) return { valid: false, brokenAt: i };
    if (hashEntry(prevHash, e.payload) !== e.hash) return { valid: false, brokenAt: i };
    prevHash = e.hash;
  }
  if (head && typeof head.count === 'number') {
    if (chain.length !== head.count) {
      return { valid: false, brokenAt: chain.length, reason: 'truncated' };
    }
    const lastHash = chain.length ? chain[chain.length - 1].hash : GENESIS;
    if (head.hash && lastHash !== head.hash) {
      return { valid: false, brokenAt: chain.length - 1, reason: 'head-mismatch' };
    }
  }
  return { valid: true, brokenAt: -1 };
}

async function verify() {
  return verifyChain(await all(), await head());
}

module.exports = { append, all, head, verify, verifyChain, hashEntry, canonical, GENESIS };
