'use strict';

/**
 * api/report.js — READ-ONLY analytics report for /report.
 * Gated by BOARD_PASSWORD via lib/auth.isOperator (the exact operator gate used
 * by api/board.js: X-Board-Password header / Bearer / ?pw= are all accepted by
 * readBearerOrPassword, plus ?pw= via passwordFromBody below). A rep session
 * does NOT satisfy this gate -> 401.
 *
 * GET -> the lib/analytics.js report object as JSON. No mutation path, no
 * external calls: every number derives from KV (leads + ledger).
 */

const auth = require('../lib/auth');
const analytics = require('../lib/analytics');
const { sendJson, urlOf } = require('../lib/http');

module.exports = async (req, res) => {
  // Support ?pw= alongside the header/Bearer forms auth.isOperator already reads.
  const pwParam = urlOf(req).searchParams.get('pw');
  if (!auth.isOperator(req, pwParam)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }

  if (req.method === 'GET') {
    const report = await analytics.buildReport();
    return sendJson(res, 200, report);
  }

  return sendJson(res, 405, { error: 'method not allowed' });
};
