'use strict';

/**
 * lib/outreach.js — E2 consent-gated, HUMAN-dialed outreach GATE + LOGGER.
 *
 * This module is the compliant gate a human rep acts THROUGH. It emphatically
 * DOES NOT place a call, DOES NOT send an SMS, and has NO AI-voice path. There
 * is deliberately no dialer/SMS-provider integration here and no outbound
 * network I/O of any kind toward a homeowner — the only side effects are
 * append-only ledger writes and (on a permitted human touch) a first-touch
 * timestamp. `sent` and `dialed` are always false because nothing is ever sent
 * or dialed by code.
 *
 * An attempt is AUTHORIZED only when the channel's fail-closed gate passes:
 *   - call -> dnc.isCallable(lead).callable === true
 *   - sms  -> consent.isSmsCallable(lead.phone).callable === true
 *             (which itself fails closed on missing consent AND on any STOP/
 *             opt-out — an opted-out number can never be authorized here)
 * A BLOCKED attempt is ledgered ('outreach.blocked') and returns the reason.
 * A PERMITTED attempt is ledgered ('outreach.attempt'), stamps firstTouchAt
 * when a human acts, and returns — the human then dials/texts by hand.
 */

const dnc = require('./dnc');
const consent = require('./consent');
const ledger = require('./ledger');
const leads = require('./leads');

// The only two channels a human can act through. There is intentionally no
// 'ai-voice' / 'autodial' / 'bulk-sms' channel.
const CHANNELS = new Set(['call', 'sms']);

/** Resolve the fail-closed gate for a channel. Pure over lead/consent state. */
async function gateFor(channel, lead) {
  if (channel === 'call') return dnc.isCallable(lead);
  // SMS gate is keyed on the phone and already enforces opt-out precedence.
  return consent.isSmsCallable(lead.phone);
}

/**
 * Attempt an outreach touch. `channel` ∈ {call, sms}; `actor` is server-derived
 * (operator or rep name), never trusted from a request body. `message` is
 * accepted for the composer UX but is NEVER transmitted anywhere.
 */
async function attempt(lead, { channel, actor = 'system', message } = {}) {
  if (!lead) {
    const err = new Error('lead required');
    err.code = 'NO_LEAD';
    throw err;
  }
  const ch = String(channel || '');
  if (!CHANNELS.has(ch)) {
    const err = new Error(`invalid channel: ${ch}`);
    err.code = 'BAD_CHANNEL';
    throw err;
  }

  const gate = await gateFor(ch, lead);

  // HARD BLOCK: the gate failed closed. Log the blocked attempt and stop.
  if (!gate.callable) {
    await ledger.append({
      type: 'outreach.blocked',
      leadId: lead.id,
      actor,
      data: { channel: ch, reason: gate.reason },
    });
    return { permitted: false, channel: ch, reason: gate.reason, sent: false, dialed: false };
  }

  // PERMITTED: a human is about to act by hand. Stamp first-touch (SLA anchor)
  // if this is the first human touch, and log it. NOTHING is sent or dialed.
  let stampedFirstTouch = false;
  if (!lead.firstTouchAt && actor && actor !== 'system') {
    lead.firstTouchAt = new Date().toISOString();
    stampedFirstTouch = true;
    await leads.saveLead(lead);
  }
  await ledger.append({
    type: 'outreach.attempt',
    leadId: lead.id,
    actor,
    data: { channel: ch, reason: gate.reason, stampedFirstTouch, hasMessage: Boolean(message) },
  });
  return {
    permitted: true,
    channel: ch,
    reason: gate.reason,
    sent: false,
    dialed: false,
    stampedFirstTouch,
    firstTouchAt: lead.firstTouchAt,
  };
}

module.exports = { attempt, gateFor, CHANNELS };
