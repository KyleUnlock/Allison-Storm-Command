'use strict';

/**
 * api/callrail-webhook.js — Google LSA / CallRail inbound-call lead webhook.
 *
 * SHIPS DARK. FAIL-CLOSED without env: an unset CALLRAIL_SIGNING_KEY returns the
 * designed status — 401, NEVER 500 — and NEVER creates a lead.
 *
 * Verifies CallRail's HMAC-SHA256 signature (base64 digest) over the RAW body
 * with CALLRAIL_SIGNING_KEY, then maps the call payload into the EXISTING
 * sanitized lead path (leads.createLead) with source='ad' and adSource='callrail'
 * (or 'lsa' when the call originates from Google Local Services). The caller
 * number is captured but remains a COLD 'ad'-source phone — NOT callable until
 * DNC-scrubbed (lib/dnc). knownCustomer is forced false; no consent/DNC flag is
 * ever trusted from the payload.
 *
 * NOTE (live deploy): the signature is checked over raw bytes — see the raw-body
 * note in api/meta-webhook.js.
 */

const leads = require('../lib/leads');
const { readRawBody, verifySignature } = require('../lib/webhook-verify');
const { sendJson } = require('../lib/http');

/** Detect Google Local Services (LSA) origin to tag adSource='lsa'. */
function isLsa(payload) {
  const hay = [
    payload.lead_source,
    payload.source,
    payload.source_name,
    payload.campaign,
    payload.medium,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return /lsa|local[\s_-]*service/.test(hay);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const secret = process.env.CALLRAIL_SIGNING_KEY;
  if (!secret) {
    // Signing key unset -> ship-dark fail-closed. Designed status, never 500/lead.
    return sendJson(res, 401, { error: 'webhook not configured' });
  }

  const raw = await readRawBody(req);
  const h = req.headers || {};
  const signature = h['x-callrail-signature'] || h['signature'] || '';
  const ok = verifySignature(raw, { secret, signature, encoding: 'base64' });
  if (!ok) {
    return sendJson(res, 401, { error: 'invalid signature' });
  }

  let payload = {};
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const adSource = isLsa(payload) ? 'lsa' : 'callrail';

  // Campaign / source-ROI identifiers for the analytics phase (D3).
  const campaign = {
    campaign: payload.campaign,
    source: payload.source || payload.lead_source,
    medium: payload.medium,
    keywords: payload.keywords,
    trackingNumber: payload.tracking_phone_number || payload.tracking_number,
    callId: payload.id || payload.resource_id,
    gclid: payload.gclid, // click id anchor when present
    costId: payload.gclid || payload.id,
  };

  const lead = await leads.createLead(
    {
      // Caller number — captured but COLD (source 'ad'): not callable until
      // DNC-scrubbed. lib/leads sanitizes it via cleanPhone.
      phone: payload.customer_phone_number || payload.caller_number || payload.phone,
      name: payload.customer_name || payload.caller_name,
      zip: payload.customer_zip || payload.customer_postal_code,
      address: payload.customer_address,
      notes: `Inbound call via ${adSource} (${payload.duration || '0'}s)`,
    },
    {
      source: 'ad',
      adSource,
      campaign,
      knownCustomer: false, // forced — never trusted from payload
      consent: false, // cold ad lead; not callable until DNC-scrubbed
      assignedRep: null,
    }
  );

  return sendJson(res, 200, { ok: true, id: lead.id, adSource });
};
