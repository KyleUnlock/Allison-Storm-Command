'use strict';

/**
 * lib/store.js — tiny KV wrapper over Upstash/Vercel KV REST.
 *
 * Exactly FIVE primitives, used everywhere:
 *   get(key)            -> value | null
 *   set(key, value)     -> 'OK'
 *   del(key)            -> number deleted
 *   listPush(key, val)  -> new length   (append to a list)
 *   listRange(key)      -> array         (full list, oldest -> newest)
 *
 * Reads KV_REST_API_URL + KV_REST_API_TOKEN (NOT UPSTASH_*).
 * Falls back to an in-memory Map when those are unset, so tests and local
 * dev run with no live KV.
 *
 * All values are JSON-encoded on the way in and JSON-decoded on the way out
 * so callers store/read plain JS objects.
 */

const URL_ENV = process.env.KV_REST_API_URL;
const TOKEN_ENV = process.env.KV_REST_API_TOKEN;
const LIVE = Boolean(URL_ENV && TOKEN_ENV);

// ---- in-memory fallback -----------------------------------------------------
const mem = new Map();
const locks = new Map(); // key -> expiry epoch ms (in-memory setNx)

function memGet(key) {
  return mem.has(key) ? JSON.parse(mem.get(key)) : null;
}
function memSet(key, value) {
  mem.set(key, JSON.stringify(value));
  return 'OK';
}
function memDel(key) {
  return mem.delete(key) ? 1 : 0;
}
function memListPush(key, value) {
  const raw = mem.has(key) ? JSON.parse(mem.get(key)) : [];
  raw.push(value);
  mem.set(key, JSON.stringify(raw));
  return raw.length;
}
function memListRange(key) {
  return mem.has(key) ? JSON.parse(mem.get(key)) : [];
}
// Atomic-within-the-event-loop check-and-set with TTL. Node is single-threaded,
// so the read + set below cannot interleave — this is a real mutex across the
// async await points that separate a lock holder's critical section.
function memSetNx(key, ttlMs) {
  const nowMs = Date.now();
  const exp = locks.get(key);
  if (exp && exp > nowMs) return false; // still held
  locks.set(key, nowMs + ttlMs);
  return true;
}
function memLockDel(key) {
  return locks.delete(key) ? 1 : 0;
}

// ---- live Upstash REST ------------------------------------------------------
async function rest(command) {
  // Upstash REST accepts a pipeline-style command array.
  const res = await fetch(URL_ENV, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN_ENV}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    throw new Error(`KV ${command[0]} failed: ${res.status}`);
  }
  const data = await res.json();
  return data.result;
}

async function liveGet(key) {
  const raw = await rest(['GET', key]);
  return raw == null ? null : JSON.parse(raw);
}
async function liveSet(key, value) {
  await rest(['SET', key, JSON.stringify(value)]);
  return 'OK';
}
async function liveDel(key) {
  return rest(['DEL', key]);
}
async function liveListPush(key, value) {
  return rest(['RPUSH', key, JSON.stringify(value)]);
}
async function liveListRange(key) {
  const raw = await rest(['LRANGE', key, 0, -1]);
  return (raw || []).map((s) => JSON.parse(s));
}
// Redis SET key val NX PX ttl -> "OK" when acquired, null when the key is held.
async function liveSetNx(key, ttlMs) {
  const r = await rest(['SET', key, '1', 'NX', 'PX', ttlMs]);
  return r === 'OK';
}

// ---- public surface (always async so callers can await uniformly) -----------
async function get(key) {
  return LIVE ? liveGet(key) : memGet(key);
}
async function set(key, value) {
  return LIVE ? liveSet(key, value) : memSet(key, value);
}
async function del(key) {
  return LIVE ? liveDel(key) : memDel(key);
}
async function listPush(key, value) {
  return LIVE ? liveListPush(key, value) : memListPush(key, value);
}
async function listRange(key) {
  return LIVE ? liveListRange(key) : memListRange(key);
}
/**
 * setNx(key, ttlMs) -> true iff the lock was acquired. Backed by Redis
 * `SET NX PX` in prod and an event-loop-atomic check-and-set in memory. Release
 * with delLock(key) (a plain del that also clears the in-memory lock table).
 */
async function setNx(key, ttlMs) {
  return LIVE ? liveSetNx(key, ttlMs) : memSetNx(key, ttlMs);
}
async function delLock(key) {
  return LIVE ? liveDel(key) : memLockDel(key);
}

// test/dev helper — wipe the in-memory store between suites.
function _resetMemory() {
  mem.clear();
  locks.clear();
}

module.exports = {
  get,
  set,
  del,
  listPush,
  listRange,
  setNx,
  delLock,
  LIVE,
  _resetMemory,
};
