'use strict';

/**
 * api/storm-status.js — PUBLIC. Returns NWS-compliant hail messaging for a ZIP.
 * Phrasing is fixed ("hail reported near [ZIP] per NWS"); never a per-home
 * claim, never any fee-absorption language. Uses WHATWG URL for ?zip=.
 */

const storm = require('../lib/storm');
const { sendJson, urlOf } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const zip = urlOf(req).searchParams.get('zip') || '';
  // Live NWS feed when STORM_LIVE is on; fail-safe to the sync stub otherwise.
  // Any feed error resolves to reported:false inside hailReportLive — this
  // public endpoint never 500s on a down feed.
  const report = await storm.hailReportLive(zip);
  return sendJson(res, 200, {
    zip: report.zip,
    reported: report.reported,
    headline: storm.compliantHeadline(zip),
    blurb: storm.compliantBlurbFrom(zip, report),
    report,
  });
};
