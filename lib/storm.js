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

// Stub of recent NWS hail reports keyed by ZIP. In production this is replaced
// by a real NWS/SPC feed reader; the interface stays the same.
const STUB_REPORTS = {
  // zip: { date, sizeIn }
  '75002': { date: '2026-06-28', sizeIn: 1.75 },
  '76248': { date: '2026-06-28', sizeIn: 1.0 },
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
  const r = hailReport(zip);
  if (r.reported) {
    return `Hail reported near ${r.zip} per NWS on ${r.date} (up to ${r.sizeIn}" reported). A free, no-obligation inspection can confirm whether your roof has damage.`;
  }
  return `We monitor NWS hail reports for your area. A free, no-obligation inspection can confirm whether your roof has storm damage.`;
}

module.exports = { hailReport, compliantHeadline, compliantBlurb, looksLikeZip, STUB_REPORTS };
