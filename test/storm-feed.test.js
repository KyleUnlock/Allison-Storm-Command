'use strict';

/**
 * test/storm-feed.test.js — Phase E live NWS hail feed.
 * Fully offline: a fake fetch serves centroid + LSR fixtures, an isolated
 * in-memory store backs the cache, and the clock is injected. No network.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

const feed = require('../lib/storm-feed');
const storm = require('../lib/storm');

// Fixed clock so time-window math is deterministic.
const NOW = Date.parse('2026-07-10T18:00:00Z');
const now = () => NOW;
const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// Houston 77002 centroid.
const HOU = { lat: 29.7604, lon: -95.3698 };

function makeStore() {
  const m = new Map();
  return {
    async get(k) {
      return m.has(k) ? JSON.parse(m.get(k)) : null;
    },
    async set(k, v) {
      m.set(k, JSON.stringify(v));
      return 'OK';
    },
    _map: m,
  };
}

// A fake fetch that dispatches by URL and counts calls per kind.
function makeFetch({ centroid = HOU, features = [], failCentroid = false, failLsr = false, throwOn = null } = {}) {
  const calls = { centroid: 0, lsr: 0 };
  const fn = async (url) => {
    const u = String(url);
    if (throwOn && u.includes(throwOn)) throw new Error('boom');
    if (u.includes('zippopotam') || u.includes('/us/')) {
      calls.centroid += 1;
      if (failCentroid) return { ok: false, status: 404, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          'post code': '77002',
          places: [{ latitude: String(centroid.lat), longitude: String(centroid.lon), 'place name': 'Houston' }],
        }),
      };
    }
    if (u.includes('lsr')) {
      calls.lsr += 1;
      if (failLsr) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, json: async () => ({ type: 'FeatureCollection', features }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

function hailFeature(lat, lon, whenIso, sizeIn, type = 'H') {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { type, typetext: 'HAIL', magnitude: sizeIn, valid: whenIso, city: 'HOUSTON', st: 'TX' },
  };
}

afterEach(() => {
  delete process.env.STORM_LIVE;
});

// ---- dark flag ---------------------------------------------------------------

test('STORM_LIVE off: hailReportLive returns the sync stub answer (no feed call)', async () => {
  delete process.env.STORM_LIVE;
  const fetch = makeFetch({ features: [hailFeature(29.79, -95.35, daysAgo(5), 1.75)] });
  const r = await storm.hailReportLive('77005', { fetch, store: makeStore(), now });
  // Stub knows nothing about 77005 -> not reported; and the feed was never hit.
  assert.strictEqual(r.reported, false);
  assert.strictEqual(fetch.calls.lsr, 0);
  assert.strictEqual(fetch.calls.centroid, 0);
  // Sanity: the stub's own known ZIP (77002) still reports through the wrapper.
  assert.strictEqual((await storm.hailReportLive('77002', { fetch, store: makeStore(), now })).reported, true);
});

// ---- live hit / miss ---------------------------------------------------------

test('STORM_LIVE on: a nearby recent hail LSR -> reported with date, size, distance', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({
    features: [
      hailFeature(29.79, -95.35, daysAgo(5), 1.25),
      hailFeature(29.77, -95.37, daysAgo(2), 2.0), // most recent + largest
      hailFeature(31.5, -97.5, daysAgo(1), 3.0), // far away -> excluded
    ],
  });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, true);
  assert.strictEqual(r.date, daysAgo(2).slice(0, 10)); // most recent nearby
  assert.strictEqual(r.sizeIn, 2.0); // largest nearby magnitude
  assert.ok(r.distanceMi >= 0 && r.distanceMi <= 25);
  assert.strictEqual(r.source, 'nws-lsr');
});

test('distance filter: hail beyond the radius is not reported', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({ features: [hailFeature(31.5, -97.5, daysAgo(3), 2.5)] }); // ~150mi off
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
});

test('time window: hail older than the window is not reported', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({ features: [hailFeature(29.77, -95.37, daysAgo(400), 2.0)] });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
});

test('non-hail LSRs (e.g. tornado/wind) are ignored', async () => {
  process.env.STORM_LIVE = '1';
  const tornado = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-95.37, 29.77] },
    properties: { type: 'T', typetext: 'TORNADO', magnitude: 0, valid: daysAgo(1) },
  };
  const fetch = makeFetch({ features: [tornado] });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
});

// ---- fail-safe ---------------------------------------------------------------

test('fail-safe: LSR feed down (non-2xx) -> reported:false + degraded, never throws', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({ failLsr: true });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
  assert.strictEqual(r.degraded, true);
});

test('fail-safe: fetch throws -> reported:false + degraded, intake copy safe', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({ throwOn: 'lsr' });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
  assert.strictEqual(r.degraded, true);
});

test('fail-safe: unknown/unresolvable ZIP centroid -> reported:false', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({ failCentroid: true });
  const r = await feed.fetchHailNearZip('99999', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
  assert.strictEqual(r.degraded, true);
});

test('fail-safe: hailReportLive swallows feed errors down to the sync answer', async () => {
  process.env.STORM_LIVE = '1';
  // A feed whose fetch rejects entirely; live wrapper must not throw.
  const fetch = makeFetch({ throwOn: '/us/' }); // centroid throws
  const r = await storm.hailReportLive('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false); // honest, not fabricated
});

test('invalid ZIP short-circuits before any fetch', async () => {
  process.env.STORM_LIVE = '1';
  const fetch = makeFetch({});
  const r = await feed.fetchHailNearZip('abc', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, false);
  assert.strictEqual(r.zip, null);
  assert.strictEqual(fetch.calls.centroid, 0);
});

// ---- centroid cache: short-miss TTL, not 30 days -----------------------------

test('centroid: a transient miss is cached briefly and retried (not blackholed 30d)', async () => {
  process.env.STORM_LIVE = '1';
  const store = makeStore();
  const T = NOW;
  // 1) zippopotam blips -> null centroid, cached with the SHORT miss TTL.
  const a = await feed.zipCentroid('77002', { fetch: makeFetch({ failCentroid: true }), store, now: () => T });
  assert.strictEqual(a, null);
  // 2) within 15 min: still serving the cached miss (no refetch attempt needed).
  const b = await feed.zipCentroid('77002', { fetch: makeFetch({}), store, now: () => T + 5 * 60 * 1000 });
  assert.strictEqual(b, null);
  // 3) after 15 min: the miss expired, so a now-healthy lookup resolves.
  const c = await feed.zipCentroid('77002', { fetch: makeFetch({}), store, now: () => T + 16 * 60 * 1000 });
  assert.ok(c && Number.isFinite(c.lat), 'valid ZIP recovers once the feed is healthy');
});

// ---- cache -------------------------------------------------------------------

test('cache: a second lookup is served from the store, no repeat fetch', async () => {
  process.env.STORM_LIVE = '1';
  const store = makeStore();
  const fetch = makeFetch({ features: [hailFeature(29.77, -95.37, daysAgo(2), 1.75)] });
  const a = await feed.fetchHailNearZip('77002', { fetch, store, now });
  const b = await feed.fetchHailNearZip('77002', { fetch, store, now });
  assert.deepStrictEqual(a, b);
  assert.strictEqual(fetch.calls.centroid, 1, 'centroid fetched once');
  assert.strictEqual(fetch.calls.lsr, 1, 'LSR fetched once');
});

// ---- honest copy -------------------------------------------------------------

test('compliantBlurbFrom: live hit renders NWS ZIP-scoped copy, never per-home', () => {
  const report = { zip: '77002', reported: true, date: '2026-07-08', sizeIn: 2.0 };
  const blurb = storm.compliantBlurbFrom('77002', report);
  assert.match(blurb, /hail reported near 77002 per NWS/i);
  assert.match(blurb, /up to 2["]/);
  assert.doesNotMatch(blurb, /your roof was hit/i);
  assert.doesNotMatch(blurb, /your (home|house|roof) was/i);
});

test('compliantBlurbFrom: reported hit with no size omits the "up to" clause', () => {
  const blurb = storm.compliantBlurbFrom('77002', { zip: '77002', reported: true, date: '2026-07-08', sizeIn: null });
  assert.match(blurb, /hail reported near 77002 per NWS on 2026-07-08/i);
  assert.doesNotMatch(blurb, /up to/i);
});

test('compliantBlurbFrom: not-reported falls back to the monitoring blurb', () => {
  const blurb = storm.compliantBlurbFrom('77002', { reported: false });
  assert.match(blurb, /we monitor NWS hail reports/i);
  assert.doesNotMatch(blurb, /your roof was hit/i);
});

// ---- geo unit ----------------------------------------------------------------

test('haversineMi: known separation is within tolerance', () => {
  // ~ 3.0 miles between two near-downtown Houston points.
  const d = feed.haversineMi(29.7604, -95.3698, 29.79, -95.35);
  assert.ok(d > 1 && d < 6, `expected ~3mi, got ${d}`);
  assert.strictEqual(feed.haversineMi(29.76, -95.36, 29.76, -95.36), 0);
});

test('isHailFeature: H type or HAIL typetext true; others false', () => {
  assert.strictEqual(feed.isHailFeature({ type: 'H' }), true);
  assert.strictEqual(feed.isHailFeature({ typetext: 'Hail' }), true);
  assert.strictEqual(feed.isHailFeature({ type: 'T', typetext: 'TORNADO' }), false);
  assert.strictEqual(feed.isHailFeature(null), false);
});

test('hailSizeIn: reads live IEM magf, falls back to magnitude/mag', () => {
  assert.strictEqual(feed.hailSizeIn({ magf: 0.5 }), 0.5); // live IEM field
  assert.strictEqual(feed.hailSizeIn({ magnitude: 1.75 }), 1.75);
  assert.strictEqual(feed.hailSizeIn({ mag: 2.0 }), 2.0);
  assert.ok(Number.isNaN(feed.hailSizeIn({}))); // no size -> NaN -> "up to" omitted
  assert.ok(Number.isNaN(feed.hailSizeIn(null)));
});

test('featureLonLat: geometry first, falls back to properties.lon/lat', () => {
  assert.deepStrictEqual(
    feed.featureLonLat({ geometry: { coordinates: [-95.36, 29.76] } }),
    { lat: 29.76, lon: -95.36 }
  );
  // Live IEM carries lon/lat on properties too — use them if geometry is absent.
  assert.deepStrictEqual(
    feed.featureLonLat({ properties: { lon: -94.83, lat: 29.81 } }),
    { lat: 29.81, lon: -94.83 }
  );
  assert.strictEqual(feed.featureLonLat({}), null);
});

test('live IEM shape (magf + geometry) parses to a sized report', async () => {
  process.env.STORM_LIVE = '1';
  // Mirror the exact live IEM feature shape observed 2026-07-10.
  const liveShape = {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [-95.37, 29.77] },
    properties: { wfo: 'HGX', type: 'H', typetext: 'HAIL', magf: 1.5, unit: 'Inch', valid: daysAgo(3) },
  };
  const fetch = makeFetch({ features: [liveShape] });
  const r = await feed.fetchHailNearZip('77002', { fetch, store: makeStore(), now });
  assert.strictEqual(r.reported, true);
  assert.strictEqual(r.sizeIn, 1.5);
});
