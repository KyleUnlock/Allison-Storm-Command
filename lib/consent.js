'use strict';

/**
 * lib/consent.js — TX SB140 SMS consent + opt-out, ledgered and fail-safe.
 *
 * Two one-directional-safe primitives, keyed by normalized phone digits:
 *   consent:sms:<phone> -> { phone, consent:true, source, leadId, capturedAt }
 *   optout:sms:<phone>  -> { phone, optedOut:true, at, via }
 *
 * SMS-callability REQUIRES an express-consent record AND no opt-out. Absence of
 * consent withholds. Opt-out ALWAYS wins and can never be silently cleared by a
 * later consent write — once a number says STOP it stays stopped until a fresh,
 * deliberate re-consent flow (which this module intentionally does not expose).
 *
 * Nothing here sends a message; this is consent bookkeeping + gating only.
 */

const ledger = require('./ledger');
const store = require('./store');
const sanitize = require('./sanitize');

const consentKey = (phone) => `consent:sms:${phone}`;
const optOutKey = (phone) => `optout:sms:${phone}`;

// Carrier-standard opt-out keywords.
const STOP_WORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'REVOKE',
]);

// SB140-compliant express-consent language shown on the public intake. This is
// the single source of truth; index.html embeds it verbatim and
// scripts/lint-copy.js asserts the marker below is present on the page.
const SMS_CONSENT_LANGUAGE =
  'By checking this box, I give my express written consent to receive SMS text messages ' +
  'from Allison Roofing at the phone number I provided about my free inspection and ' +
  'storm-restoration project. Consent is not a condition of any purchase. Message and ' +
  'data rates may apply. Reply STOP to opt out at any time; reply HELP for help.';

// Distinctive substring the copy linter requires on the intake page.
const SMS_CONSENT_MARKER = 'express written consent to receive SMS text messages';

function normPhone(phone) {
  return sanitize.cleanPhone(phone);
}

async function isOptedOut(phone) {
  const p = normPhone(phone);
  if (!p) return false;
  const rec = await store.get(optOutKey(p));
  return Boolean(rec && rec.optedOut === true);
}

async function getConsent(phone) {
  const p = normPhone(phone);
  if (!p) return null;
  return store.get(consentKey(p));
}

/**
 * Capture SMS consent (e.g. the intake opt-in checkbox). Ledgered. Fail-safe:
 * writing a consent record does NOT clear an existing opt-out — the opt-out
 * still governs isSmsCallable, so consent can never silently re-open a stopped
 * number.
 */
async function recordConsent(phone, { source, leadId, actor } = {}) {
  const p = normPhone(phone);
  if (!p) return null;
  const rec = {
    phone: p,
    consent: true,
    source: source || 'unknown',
    leadId: leadId || null,
    capturedAt: new Date().toISOString(),
  };
  await store.set(consentKey(p), rec);
  await ledger.append({
    type: 'sms.consent',
    actor: actor || 'public',
    data: { phone: p, source: rec.source, leadId: rec.leadId },
  });
  return rec;
}

/**
 * Record an opt-out (STOP). One-directional: sets the opt-out flag and ledgers
 * it. There is deliberately no primitive here to clear it.
 */
async function recordOptOut(phone, { actor, via, message } = {}) {
  const p = normPhone(phone);
  if (!p) return null;
  const rec = {
    phone: p,
    optedOut: true,
    at: new Date().toISOString(),
    via: via || 'sms',
  };
  await store.set(optOutKey(p), rec);
  await ledger.append({
    type: 'sms.optout',
    actor: actor || 'consumer',
    data: { phone: p, via: rec.via, message: message || '' },
  });
  return rec;
}

/**
 * The SMS gate. Callable ONLY with a consent record AND no opt-out. Missing
 * consent withholds; an opt-out always wins.
 */
async function isSmsCallable(phone) {
  const p = normPhone(phone);
  if (!p) return { callable: false, reason: 'no-phone' };
  if (await isOptedOut(p)) return { callable: false, reason: 'sms-opted-out' };
  const c = await store.get(consentKey(p));
  if (!c || c.consent !== true) return { callable: false, reason: 'no-consent' };
  return { callable: true, reason: 'sms-consent' };
}

function isStopKeyword(message) {
  if (!message) return false;
  return STOP_WORDS.has(String(message).trim().toUpperCase());
}

module.exports = {
  SMS_CONSENT_LANGUAGE,
  SMS_CONSENT_MARKER,
  STOP_WORDS,
  recordConsent,
  recordOptOut,
  isSmsCallable,
  isOptedOut,
  getConsent,
  isStopKeyword,
  normPhone,
  consentKey,
  optOutKey,
};
