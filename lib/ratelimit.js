'use strict';

/**
 * lib/ratelimit.js — KV-backed fixed-window rate limiter.
 *
 * Best-effort defense-in-depth (brute-force / flood throttle), NOT a security
 * fence: it FAILS OPEN on any store error so a KV blip cannot lock out a
 * legitimate operator or rep. In prod the counter lives in Upstash and is shared
 * across serverless instances; with the in-memory fallback the window is
 * per-instance, so real throttling requires real KV.
 */

const store = require('./store');

/**
 * clientIp(req) — best-guess client IP from Vercel's TRUSTED forwarding headers
 * first (x-vercel-forwarded-for / x-real-ip), falling back to the spoofable
 * x-forwarded-for only as a last resort. Returns 'unknown' when nothing is set.
 */
function clientIp(req) {
  const h = (req && req.headers) || {};
  const first = (v) => (v ? String(v).split(',')[0].trim() : '');
  return (
    first(h['x-vercel-forwarded-for']) ||
    first(h['x-real-ip']) ||
    first(h['x-forwarded-for']) ||
    'unknown'
  );
}

/** True when `key` has already reached `max` hits inside the current window. */
async function isBlocked(key, { max }) {
  try {
    const rec = await store.get(key);
    if (!rec || typeof rec.resetAt !== 'number' || Date.now() > rec.resetAt) return false;
    return rec.count >= max;
  } catch {
    return false; // fail open
  }
}

/** Record one hit against `key`; returns { blocked, count } for the window. */
async function hit(key, { max, windowMs }) {
  try {
    const now = Date.now();
    let rec = await store.get(key);
    if (!rec || typeof rec.resetAt !== 'number' || now > rec.resetAt) {
      rec = { count: 0, resetAt: now + windowMs };
    }
    rec.count += 1;
    await store.set(key, rec);
    return { blocked: rec.count > max, count: rec.count };
  } catch {
    return { blocked: false, count: 0 }; // fail open
  }
}

/** Clear a key's counter (e.g. on a successful login). */
async function clear(key) {
  try {
    await store.del(key);
  } catch {
    /* best-effort */
  }
}

module.exports = { clientIp, isBlocked, hit, clear };
