'use strict';

/**
 * api/meta-webhook.js — Meta (Facebook/Instagram) Instant Form lead webhook.
 *
 * SHIPS DARK. FAIL-CLOSED without env: an unset META_APP_SECRET (POST) or
 * META_VERIFY_TOKEN (GET handshake) returns the designed status — 401/403,
 * NEVER 500 — and NEVER creates a lead. Kyle flips the env when the ad account
 * is granted.
 *
 * POST: verify Meta's `X-Hub-Signature-256: sha256=<hex>` HMAC-SHA256 over the
 *       RAW body using META_APP_SECRET, then map the Instant Form field payload
 *       into the EXISTING sanitized lead path (leads.createLead) with
 *       source='ad', adSource='meta'. knownCustomer is forced false and NO
 *       consent/DNC flag is ever trusted from the payload -> a cold ad lead is
 *       not callable until DNC-scrubbed.
 * GET:  Meta subscription handshake — echo hub.challenge ONLY when
 *       hub.mode=subscribe and hub.verify_token matches META_VERIFY_TOKEN.
 *
 * NOTE (live deploy): Vercel Node functions parse JSON bodies by default; the
 * signature must be checked over raw bytes. lib/webhook-verify.readRawBody
 * drains the stream (as it does under serve.local + tests); a live deploy
 * disables body parsing for this route so the raw bytes reach us intact.
 */

const leads = require('../lib/leads');
const sanitize = require('../lib/sanitize');
const { readRawBody, verifySignature, timingSafeEqual } = require('../lib/webhook-verify');
const { sendJson, urlOf } = require('../lib/http');

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// Instant Form field-name aliases -> our sanitized lead fields.
const NAME_KEYS = new Set(['full_name', 'name', 'first_name', 'firstname']);
const PHONE_KEYS = new Set(['phone_number', 'phone', 'phone_number_1']);
const EMAIL_KEYS = new Set(['email', 'email_address', 'work_email']);
const ZIP_KEYS = new Set(['zip', 'zip_code', 'postal_code', 'postcode']);
const ADDRESS_KEYS = new Set(['street_address', 'address', 'address_line_1']);

/**
 * Pull the first leadgen change value out of a Meta webhook envelope, tolerating
 * both the real `entry[].changes[].value` shape and a already-flattened `value`
 * or top-level object (used by tests / manual replays).
 */
function extractLeadValue(payload) {
  if (!payload || typeof payload !== 'object') return {};
  if (Array.isArray(payload.entry)) {
    for (const entry of payload.entry) {
      const changes = Array.isArray(entry && entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change && change.value && typeof change.value === 'object') {
          return change.value;
        }
      }
    }
  }
  if (payload.value && typeof payload.value === 'object') return payload.value;
  return payload;
}

/** Reduce an Instant Form field_data array into a plain name->value map. */
function fieldDataToMap(value) {
  const map = {};
  const fd = Array.isArray(value && value.field_data) ? value.field_data : [];
  for (const f of fd) {
    if (!f || !f.name) continue;
    const key = String(f.name).toLowerCase();
    const val = Array.isArray(f.values) ? f.values[0] : f.value;
    if (val != null) map[key] = val;
  }
  return map;
}

function pick(map, keys) {
  for (const k of Object.keys(map)) {
    if (keys.has(k)) return map[k];
  }
  return undefined;
}

module.exports = async (req, res) => {
  // ---- GET: Meta subscription verification handshake (fail closed) ----------
  if (req.method === 'GET') {
    const token = process.env.META_VERIFY_TOKEN;
    if (!token) return sendText(res, 403, 'forbidden'); // token env unset -> closed
    const q = urlOf(req).searchParams;
    const mode = q.get('hub.mode');
    const verify = q.get('hub.verify_token');
    const challenge = q.get('hub.challenge');
    if (mode === 'subscribe' && verify && timingSafeEqual(verify, token)) {
      return sendText(res, 200, challenge == null ? '' : String(challenge));
    }
    return sendText(res, 403, 'forbidden');
  }

  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  // ---- POST: signature-verified lead ingest (fail closed) -------------------
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    // Secret unset -> ship-dark fail-closed. Designed status, never 500/lead.
    return sendJson(res, 401, { error: 'webhook not configured' });
  }

  const raw = await readRawBody(req);
  const signature = (req.headers && req.headers['x-hub-signature-256']) || '';
  const ok = verifySignature(raw, { secret, signature, encoding: 'hex', prefix: 'sha256=' });
  if (!ok) {
    return sendJson(res, 401, { error: 'invalid signature' });
  }

  let payload = {};
  try {
    payload = JSON.parse(raw.toString('utf8') || '{}');
  } catch {
    payload = {};
  }

  const value = extractLeadValue(payload);
  const fields = fieldDataToMap(value);

  const created = [];
  // Campaign / source-ROI identifiers for the analytics phase (D3).
  const campaign = {
    campaignId: value.campaign_id,
    campaignName: value.campaign_name,
    adId: value.ad_id,
    adsetId: value.adset_id || value.adgroup_id,
    formId: value.form_id,
    leadgenId: value.leadgen_id,
    pageId: value.page_id,
    platform: value.platform || 'meta',
    costId: value.ad_id, // cost/click anchor available to Meta ads reporting
  };

  const lead = await leads.createLead(
    {
      name: pick(fields, NAME_KEYS),
      phone: pick(fields, PHONE_KEYS),
      email: pick(fields, EMAIL_KEYS),
      zip: pick(fields, ZIP_KEYS),
      address: pick(fields, ADDRESS_KEYS),
      notes: 'Meta Instant Form lead',
    },
    {
      source: 'ad',
      adSource: 'meta',
      campaign,
      knownCustomer: false, // forced — never trusted from payload
      consent: false, // cold ad lead; not callable until DNC-scrubbed
      assignedRep: null,
    }
  );
  created.push({ id: lead.id });

  // Meta requires a 200 or it retries the delivery.
  return sendJson(res, 200, { ok: true, id: lead.id, received: created.length });
};
