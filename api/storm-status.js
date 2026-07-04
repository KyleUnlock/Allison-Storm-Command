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
  const report = storm.hailReport(zip);
  return sendJson(res, 200, {
    zip: report.zip,
    reported: report.reported,
    headline: storm.compliantHeadline(zip),
    blurb: storm.compliantBlurb(zip),
    report,
  });
};
