'use strict';

/**
 * api/leads.js — PUBLIC lead intake (POST) + listing is NOT here (operators use
 * api/board). This endpoint is sanitized and hardened:
 *   - source accepted from {web, ad, rep} ONLY; "storm" is gated (rejected here).
 *   - knownCustomer is FORCED false (never trusted from the public body).
 *   - self-attested DNC/consent flags are NEVER accepted on the public path;
 *     consent is derived from the channel (web form = express inbound consent).
 *   - all string inputs are injection-sanitized in lib/leads.createLead.
 */

const leads = require('../lib/leads');
const { readJson, sendJson } = require('../lib/http');

const PUBLIC_SOURCES = new Set(['web', 'ad', 'rep']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const body = await readJson(req);

  const requested = String(body.source || 'web').toLowerCase();
  if (!PUBLIC_SOURCES.has(requested)) {
    // "storm" and anything else are gated off the public path.
    return sendJson(res, 400, { error: 'invalid source' });
  }

  if (!body.phone && !body.email) {
    return sendJson(res, 400, { error: 'phone or email required' });
  }

  // consent: only a web-form submission is treated as express inbound consent.
  // We deliberately IGNORE any consent/dnc field in the body.
  const consent = requested === 'web';

  const lead = await leads.createLead(
    {
      name: body.name,
      phone: body.phone,
      email: body.email,
      zip: body.zip,
      address: body.address,
      notes: body.notes,
    },
    {
      source: requested,
      knownCustomer: false, // forced
      consent,
      assignedRep: null,
    }
  );

  return sendJson(res, 201, {
    ok: true,
    id: lead.id,
    status: lead.status,
    source: lead.source,
  });
};
