'use strict';

/**
 * lib/scoring.js — deterministic lead score (0–100).
 *
 * A lead's priority score folds three signals, each capped so the total lands
 * in [0,100]. The function is PURE over (lead, now): the same lead + reference
 * clock always yields the same integer, so scores are stable, testable, and
 * safe to recompute anywhere without drift.
 *
 *   storm  (0–40): NWS hail strength near the lead ZIP (via lib/storm). A
 *                  reported hit scales with reported hail size; no report -> 0.
 *   source (0–30): channel warmth — an inbound web form is warmest, a rep-
 *                  sourced lead next, a cold ad lead lowest.
 *   recency(0–30): freshness — a just-delivered lead scores full, decaying
 *                  linearly to 0 across a 30-day horizon.
 *
 * Scoring never changes callability, attribution, or billing — it is advisory
 * prioritization only.
 */

const storm = require('./storm');

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_HORIZON_DAYS = 30;

const SOURCE_POINTS = { web: 30, rep: 20, ad: 10 };

function stormPoints(zip) {
  const r = storm.hailReport(zip);
  if (!r.reported) return 0;
  // ~1" hail -> 20, ~2"+ -> capped 40.
  return Math.min(40, Math.round((r.sizeIn || 0) * 20));
}

function sourcePoints(source) {
  const p = SOURCE_POINTS[source];
  return p == null ? 5 : p;
}

function recencyPoints(lead, now) {
  const anchor =
    Date.parse(lead.deliveredAt || lead.createdAt || '') || now;
  const ageDays = Math.max(0, (now - anchor) / DAY_MS);
  const pts = Math.round(30 * (1 - ageDays / RECENCY_HORIZON_DAYS));
  return Math.max(0, Math.min(30, pts));
}

/**
 * Deterministic score for a lead. `now` defaults to Date.now() but can be
 * pinned for reproducible tests.
 */
function scoreLead(lead, { now = Date.now() } = {}) {
  if (!lead) return 0;
  const total =
    stormPoints(lead.zip) + sourcePoints(lead.source) + recencyPoints(lead, now);
  return Math.max(0, Math.min(100, total));
}

module.exports = {
  scoreLead,
  stormPoints,
  sourcePoints,
  recencyPoints,
  SOURCE_POINTS,
  RECENCY_HORIZON_DAYS,
};
