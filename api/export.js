'use strict';

/**
 * api/export.js — operator-only CSV export of leads. Gated by BOARD_PASSWORD
 * exactly like api/board.js (a rep session does NOT satisfy this gate -> 401).
 *
 * The export runs through lib/export, whose DNC fail-safe redacts every phone
 * that is not callable per lib/dnc.js. A cold, unscrubbed number — or ANY cold
 * number while no DNC provider is configured — is withheld from the CSV. No
 * un-scrubbed phone can leave via this endpoint.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const exporter = require('../lib/export');
const { sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (!auth.isOperator(req)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const all = await leads.listLeads();
  const csv = exporter.toCsv(all);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="leads-export.csv"',
  });
  res.end(csv);
};
