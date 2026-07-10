'use strict';

/**
 * lib/storm-feed.js — Phase E: LIVE NWS hail source (replaces the STUB_REPORTS
 * table in lib/storm.js). Free + keyless. Two public data sources, both wrapped
 * in a timeout and made FAIL-SAFE:
 *
 *   1. ZIP centroid   — api.zippopotam.us/us/<zip>  (lat/lon for a US ZIP)
 *   2. NWS hail LSRs   — Iowa Environmental Mesonet (IEM) Local Storm Reports
 *                        GeoJSON, filtered to hail within a radius + time window.
 *
 * DESIGN RULES (do not loosen):
 *   - Ships DARK. Nothing here runs unless STORM_LIVE is truthy; lib/storm.js
 *     only calls in when the flag is on. Off -> the sync stub answer is used.
 *   - FAIL-SAFE everywhere: a timeout, a non-2xx, a malformed body, an unknown
 *     ZIP, or ANY thrown error resolves to { reported:false } (optionally with
 *     degraded:true). We NEVER fabricate a hit and NEVER let a feed error reach
 *     the caller — a down feed must never break the public intake page.
 *   - HONEST scope: a "hit" means an NWS hail LSR was recorded within
 *     STORM_HAIL_RADIUS_MI of the ZIP centroid in the last STORM_HAIL_WINDOW_DAYS.
 *     That is a ZIP-area statement, never a per-home strike — the copy in
 *     lib/storm.js enforces the phrasing.
 *   - CACHED in the KV store (falls back to in-memory) so intake stays fast and
 *     we do not hammer the free APIs. Centroids cache long (they do not move);
 *     hail results cache short.
 *
 * Dependency-injectable for offline tests: pass { fetch, store, now } to any
 * exported function; each defaults to the global fetch, lib/store, and Date.now.
 */

const defaultStore = require('./store');

// ---- tunables (env-overridable; safe defaults) ------------------------------
const DEFAULTS = {
  radiusMi: numEnv('STORM_HAIL_RADIUS_MI', 25), // "near" = within this many miles
  windowDays: numEnv('STORM_HAIL_WINDOW_DAYS', 365), // how far back an LSR counts
  timeoutMs: numEnv('STORM_FEED_TIMEOUT_MS', 4000), // per-request abort
  centroidTtlMs: 30 * 24 * 60 * 60 * 1000, // 30d — centroids are effectively static
  hailTtlMs: numEnv('STORM_HAIL_TTL_MS', 6 * 60 * 60 * 1000), // 6h
  // IEM LSR GeoJSON base. The WFO (Weather Forecast Office) scopes the payload;
  // HGX = Houston/Galveston, the target market. Both are env-overridable so the
  // operator can point at a verified endpoint before enabling STORM_LIVE.
  lsrUrl: process.env.STORM_LSR_URL || 'https://mesonet.agron.iastate.edu/geojson/lsr.geojson',
  lsrWfo: process.env.STORM_LSR_WFO || 'HGX',
  centroidUrl: process.env.STORM_CENTROID_URL || 'https://api.zippopotam.us/us/',
};

function numEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function isLiveEnabled() {
  const v = String(process.env.STORM_LIVE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

// ---- fetch with timeout, always fail-safe -----------------------------------
async function getJson(url, deps, timeoutMs) {
  const f = (deps && deps.fetch) || globalThis.fetch;
  if (typeof f !== 'function') return null;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || DEFAULTS.timeoutMs);
  try {
    const res = await f(url, {
      signal: ac.signal,
      headers: { accept: 'application/json', 'user-agent': 'allison-storm-command/1.0 (lead-gen)' },
    });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch {
    return null; // timeout / network / parse — fail safe
  } finally {
    clearTimeout(t);
  }
}

// ---- TTL cache over the 5-primitive store -----------------------------------
async function cacheGet(store, key, now) {
  try {
    const wrapped = await store.get(key);
    if (!wrapped || typeof wrapped !== 'object') return undefined;
    if (typeof wrapped.exp === 'number' && wrapped.exp < now) return undefined; // expired
    return wrapped.v;
  } catch {
    return undefined;
  }
}

async function cacheSet(store, key, value, ttlMs, now) {
  try {
    await store.set(key, { v: value, exp: now + ttlMs });
  } catch {
    /* cache write is best-effort; never throws into the caller */
  }
}

// ---- geo ---------------------------------------------------------------------
function haversineMi(aLat, aLon, bLat, bLon) {
  const R = 3958.7613; // mean earth radius, miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

// ---- ZIP -> centroid (cached, fail-safe) ------------------------------------
async function zipCentroid(zip, deps = {}) {
  const store = deps.store || defaultStore;
  const now = deps.now ? deps.now() : Date.now();
  if (!/^\d{5}$/.test(String(zip || ''))) return null;

  const key = `stormcache:centroid:${zip}`;
  const cached = await cacheGet(store, key, now);
  if (cached !== undefined) return cached; // may be null (known-miss) or {lat,lon}

  const body = await getJson(DEFAULTS.centroidUrl + zip, deps);
  const place = body && Array.isArray(body.places) && body.places[0];
  let centroid = null;
  if (place) {
    const lat = Number(place.latitude);
    const lon = Number(place.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) centroid = { lat, lon };
  }
  await cacheSet(store, key, centroid, DEFAULTS.centroidTtlMs, now);
  return centroid;
}

// ---- LSR feed -> nearby hail (cached, fail-safe) ----------------------------
function buildLsrUrl(now, windowDays) {
  const ets = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sts = new Date(now - windowDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  const u = new URL(DEFAULTS.lsrUrl);
  u.searchParams.set('sts', sts);
  u.searchParams.set('ets', ets);
  if (DEFAULTS.lsrWfo) u.searchParams.set('wfos', DEFAULTS.lsrWfo);
  return u.toString();
}

// Standard IEM LSR GeoJSON: features[].geometry.coordinates = [lon,lat];
// properties.type === 'H' (hail) / typetext ~ /hail/i; hail size lives in
// properties.magf (float inches) on the live feed — older/other shapes use
// magnitude; properties.valid = ISO timestamp. Verified against the live IEM
// endpoint 2026-07-10 (sample: {type:'H', typetext:'HAIL', magf:0.5, unit:'Inch'}).
function isHailFeature(props) {
  if (!props) return false;
  if (String(props.type || '').toUpperCase() === 'H') return true;
  return /hail/i.test(String(props.typetext || props.type || ''));
}

// Hail size in inches from a feature's properties, across field-name variants.
function hailSizeIn(props) {
  if (!props) return NaN;
  for (const k of ['magf', 'magnitude', 'mag']) {
    const n = Number(props[k]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return NaN;
}

// [lon,lat] from geometry, falling back to properties.lon/lat (IEM carries both).
function featureLonLat(feat) {
  const g = feat && feat.geometry;
  if (g && Array.isArray(g.coordinates)) {
    const lon = Number(g.coordinates[0]);
    const lat = Number(g.coordinates[1]);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  const p = feat && feat.properties;
  if (p) {
    const lon = Number(p.lon);
    const lat = Number(p.lat);
    if (Number.isFinite(lat) && Number.isFinite(lon)) return { lat, lon };
  }
  return null;
}

/**
 * recentHailNear(centroid, deps) -> fail-safe hail summary near a lat/lon.
 * Returns { reported:false } or
 * { reported:true, date:'YYYY-MM-DD', sizeIn:Number, distanceMi:Number, count }.
 * "date" is the most-recent qualifying report; "sizeIn" is the largest hail
 * magnitude among nearby recent reports (honest "up to X inches" wording).
 */
async function recentHailNear(centroid, deps = {}) {
  if (!centroid) return { reported: false };
  const store = deps.store || defaultStore;
  const now = deps.now ? deps.now() : Date.now();
  const windowDays = DEFAULTS.windowDays;
  const radiusMi = DEFAULTS.radiusMi;

  const key = `stormcache:hail:${centroid.lat.toFixed(2)},${centroid.lon.toFixed(2)}`;
  const cached = await cacheGet(store, key, now);
  if (cached !== undefined) return cached;

  const body = await getJson(buildLsrUrl(now, windowDays), deps);
  const feats = body && Array.isArray(body.features) ? body.features : null;
  if (!feats) {
    // Feed down/malformed. Cache a SHORT miss so we retry soon, and flag degraded.
    const miss = { reported: false, degraded: true };
    await cacheSet(store, key, miss, Math.min(DEFAULTS.hailTtlMs, 15 * 60 * 1000), now);
    return miss;
  }

  const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
  let best = null; // most recent qualifying report
  let maxSize = 0;
  let count = 0;
  for (const feat of feats) {
    const p = feat && feat.properties;
    if (!isHailFeature(p)) continue;
    const ll = featureLonLat(feat);
    if (!ll) continue;
    const when = Date.parse(p.valid || p.utc_valid || '');
    if (!Number.isFinite(when) || when < cutoff || when > now + 60 * 60 * 1000) continue;
    const dist = haversineMi(centroid.lat, centroid.lon, ll.lat, ll.lon);
    if (dist > radiusMi) continue;
    count += 1;
    const size = hailSizeIn(p);
    if (Number.isFinite(size) && size > maxSize) maxSize = size;
    if (!best || when > best.when) best = { when, dist };
  }

  let result;
  if (!best) {
    result = { reported: false };
  } else {
    result = {
      reported: true,
      date: new Date(best.when).toISOString().slice(0, 10),
      sizeIn: maxSize > 0 ? Math.round(maxSize * 100) / 100 : null,
      distanceMi: Math.round(best.dist * 10) / 10,
      count,
    };
  }
  await cacheSet(store, key, result, DEFAULTS.hailTtlMs, now);
  return result;
}

/**
 * fetchHailNearZip(zip, deps) -> normalized report for a ZIP, fail-safe.
 * Shape matches lib/storm.hailReport(): { zip, reported, date?, sizeIn? } plus
 * { distanceMi?, source:'nws-lsr', degraded? } for observability.
 */
async function fetchHailNearZip(zip, deps = {}) {
  if (!/^\d{5}$/.test(String(zip || ''))) return { zip: null, reported: false };
  const z = String(zip);
  try {
    const centroid = await zipCentroid(z, deps);
    if (!centroid) return { zip: z, reported: false, source: 'nws-lsr', degraded: true };
    const hail = await recentHailNear(centroid, deps);
    return { zip: z, source: 'nws-lsr', ...hail };
  } catch {
    return { zip: z, reported: false, source: 'nws-lsr', degraded: true };
  }
}

module.exports = {
  isLiveEnabled,
  fetchHailNearZip,
  zipCentroid,
  recentHailNear,
  haversineMi,
  buildLsrUrl,
  isHailFeature,
  hailSizeIn,
  featureLonLat,
  DEFAULTS,
};
