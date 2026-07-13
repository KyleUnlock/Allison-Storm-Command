'use strict';

/**
 * lib/storm.js — NWS-phrasing + ZIP match for storm/hail messaging.
 *
 * Compliance rule (TX): storm/hail claims must read
 *   "hail reported near [ZIP] per NWS"
 * and never assert a per-home strike. This module is the single source of that
 * phrasing so every surface stays consistent and auditable.
 *
 * The NWS source here is a fail-safe stub: with no live feed we return a
 * conservative "no confirmed report" answer rather than fabricating a hit.
 */

// Stub of recent NWS hail reports keyed by ZIP (Houston metro — Allison's
// market). In production this is replaced by the live NWS/SPC feed reader
// (lib/storm-feed, STORM_LIVE); the interface stays the same.
const STUB_REPORTS = {
  // zip: { date, sizeIn }
  '77002': { date: '2026-06-28', sizeIn: 1.75 }, // Downtown Houston
  '77433': { date: '2026-06-28', sizeIn: 1.0 }, // Cypress / NW Houston
};

function looksLikeZip(zip) {
  return /^\d{5}$/.test(String(zip || ''));
}

/**
 * Look up whether NWS reported hail near a ZIP. Fail-safe: unknown/invalid ZIP
 * returns { reported:false }. Never asserts a strike on a specific home.
 */
function hailReport(zip) {
  if (!looksLikeZip(zip)) return { zip: null, reported: false };
  const hit = STUB_REPORTS[String(zip)];
  if (!hit) return { zip: String(zip), reported: false };
  return { zip: String(zip), reported: true, date: hit.date, sizeIn: hit.sizeIn };
}

/**
 * The ONLY approved storm headline. Compliant phrasing, ZIP-scoped, no
 * per-home claim, no fee-absorption language.
 */
function compliantHeadline(zip) {
  const z = looksLikeZip(zip) ? String(zip) : 'your area';
  return `Hail reported near ${z} per NWS`;
}

function compliantBlurb(zip) {
  return compliantBlurbFrom(zip, hailReport(zip));
}

/**
 * Same compliant blurb, but from an already-resolved report object (so the live
 * feed's answer flows into the copy without a second lookup). Fail-safe: a null
 * or not-reported report yields the monitoring blurb, never a fabricated hit.
 * "up to X inches" is only shown when a real hail size is present.
 */
function compliantBlurbFrom(zip, report) {
  const r = report || { reported: false };
  if (r.reported) {
    const z = r.zip || (looksLikeZip(zip) ? String(zip) : 'your area');
    const size = r.sizeIn ? ` (up to ${r.sizeIn}" reported)` : '';
    const on = r.date ? ` on ${r.date}` : '';
    return `Hail reported near ${z} per NWS${on}${size}. A free, no-obligation inspection can confirm whether your roof has damage.`;
  }
  return `We monitor NWS hail reports for your area. A free, no-obligation inspection can confirm whether your roof has storm damage.`;
}

/**
 * hailReportLive(zip, deps) — async. When STORM_LIVE is enabled, resolves the
 * report from the live NWS LSR feed (lib/storm-feed); otherwise returns the sync
 * stub answer. FAIL-SAFE: if the feed errors or reports nothing, falls back to
 * the sync hailReport (which is itself fail-safe -> not reported). The returned
 * shape always matches hailReport(): { zip, reported, date?, sizeIn?, ... }.
 */
async function hailReportLive(zip, deps = {}) {
  if (!looksLikeZip(zip)) return { zip: null, reported: false };
  const feed = deps.feed || require('./storm-feed');
  if (!feed.isLiveEnabled()) return hailReport(zip);
  try {
    const live = await feed.fetchHailNearZip(zip, deps);
    if (live && live.reported) return live;
    // Live path ran but found nothing near this ZIP — honest "not reported".
    // Preserve degraded/source flags for observability without claiming a hit.
    return { zip: String(zip), reported: false, ...(live && live.degraded ? { degraded: true } : {}) };
  } catch {
    return hailReport(zip); // fail-safe to the sync answer
  }
}

module.exports = {
  hailReport,
  hailReportLive,
  compliantHeadline,
  compliantBlurb,
  compliantBlurbFrom,
  looksLikeZip,
  STUB_REPORTS,
};
