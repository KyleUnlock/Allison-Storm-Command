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

// test/dev helper — wipe the in-memory store between suites.
function _resetMemory() {
  mem.clear();
}

module.exports = {
  get,
  set,
  del,
  listPush,
  listRange,
  LIVE,
  _resetMemory,
};
