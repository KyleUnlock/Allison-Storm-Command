'use strict';

/**
 * api/sms-optout.js — TX SB140 STOP / opt-out handler.
 *
 * A POST here marks the contact opted-out of SMS and ledgers it. One-
 * directional-safe: this endpoint NEVER re-opens a stopped number. A non-STOP
 * inbound keyword (e.g. HELP / START) is acknowledged but performs NO opt-in —
 * re-consent is a separate, deliberate flow. Nothing is sent from here; this
 * only records state.
 *
 * Accepts an SMS-webhook-shaped body: { from|phone, message|Body }.
 */

const consent = require('../lib/consent');
const { readJson, sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const body = await readJson(req);
  const phone = body.from || body.phone || '';
  const message = body.message || body.Body || '';
  const p = consent.normPhone(phone);
  if (!p) return sendJson(res, 400, { error: 'phone required' });

  // Opt out on an explicit STOP keyword or a bare hit (the opt-out endpoint).
  if (consent.isStopKeyword(message) || !String(message).trim()) {
    const rec = await consent.recordOptOut(p, {
      actor: 'consumer',
      via: 'sms',
      message,
    });
    const state = await consent.isSmsCallable(p);
    return sendJson(res, 200, {
      ok: true,
      optedOut: true,
      smsCallable: state.callable, // always false after opt-out
      at: rec.at,
    });
  }

  // Non-STOP inbound: acknowledge, but NEVER silently re-opt-in.
  const optedOut = await consent.isOptedOut(p);
  const state = await consent.isSmsCallable(p);
  return sendJson(res, 200, {
    ok: true,
    optedOut,
    smsCallable: state.callable,
    note: 'no opt-in performed',
  });
};
