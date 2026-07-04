'use strict';

/**
 * api/storm-import.js — GATED bulk import of storm-sourced leads.
 * Gate: operator (BOARD_PASSWORD) OR the CRON_SECRET (header x-cron-secret /
 * ?secret=). This is the ONLY path allowed to stamp source="storm".
 *
 * Imported storm leads are COLD: knownCustomer=false, consent=false. They are
 * WITHHELD from calling until scrubbed by a provider with provenance
 * (lib/dnc) — that withhold is correct behavior, not a defect.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const storm = require('../lib/storm');
const { readJson, sendJson, urlOf } = require('../lib/http');

function cronOk(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const h = req.headers || {};
  const supplied = h['x-cron-secret'] || urlOf(req).searchParams.get('secret');
  return supplied === secret;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (!auth.isOperator(req) && !cronOk(req)) {
    return sendJson(res, 401, { error: 'gated: operator or cron secret' });
  }

  const body = await readJson(req);
  const rows = Array.isArray(body.leads) ? body.leads : [];
  const created = [];

  for (const row of rows) {
    // Only import rows that map to a real NWS hail report — fail-safe.
    const report = storm.hailReport(row.zip);
    if (!report.reported) continue;
    const lead = await leads.createLead(
      {
        name: row.name,
        phone: row.phone,
        email: row.email,
        zip: row.zip,
        address: row.address,
        notes: `Storm import: ${storm.compliantHeadline(row.zip)}`,
      },
      {
        source: 'storm',
        knownCustomer: false,
        consent: false, // cold — no self-attested consent
        assignedRep: null,
      }
    );
    created.push({ id: lead.id, zip: lead.zip });
  }

  return sendJson(res, 201, {
    ok: true,
    imported: created.length,
    skipped: rows.length - created.length,
    leads: created,
  });
};
