'use strict';

/**
 * lib/dnc.js — Do-Not-Call fail-safe.
 *
 * A phone is callable ONLY if it has been scrubbed by a real provider WITH
 * provenance (provider name + scrubbedAt + result). Absent a configured
 * provider (DNC_PROVIDER env), cold storm/ad leads are WITHHELD — this is
 * the CORRECT, intended default, not a bug.
 *
 * DNC/consent state changes are ledgered and one-directional-safe: once a
 * number is marked DNC it cannot be silently flipped back to callable
 * without a fresh scrub with provenance.
 */

const ledger = require('./ledger');

// "cold" acquisition = we reached out; storm/ad sources with no prior consent.
const COLD_SOURCES = new Set(['storm', 'ad']);

function providerConfigured() {
  return Boolean(process.env.DNC_PROVIDER && process.env.DNC_API_KEY);
}

/**
 * Decide callability for a lead. Pure function over lead state + env.
 * Returns { callable, reason }.
 */
function isCallable(lead) {
  if (!lead || !lead.phone) return { callable: false, reason: 'no-phone' };

  // Hard DNC flag always wins and is one-directional-safe.
  if (lead.dnc === true) return { callable: false, reason: 'on-dnc' };

  const scrub = lead.dncScrub;
  const cold = COLD_SOURCES.has(lead.source);

  // Warm inbound (homeowner submitted the web form themselves) carries its
  // own express consent and is callable without an external scrub.
  if (!cold && lead.consent === true) {
    return { callable: true, reason: 'inbound-consent' };
  }

  // Cold leads REQUIRE a provider scrub with provenance.
  if (!providerConfigured()) {
    return { callable: false, reason: 'withheld-no-provider' };
  }
  if (!scrub || !scrub.provider || !scrub.scrubbedAt) {
    return { callable: false, reason: 'withheld-unscrubbed' };
  }
  if (scrub.result === 'dnc') {
    return { callable: false, reason: 'scrub-dnc' };
  }
  if (scrub.result === 'clear') {
    return { callable: true, reason: 'scrub-clear' };
  }
  return { callable: false, reason: 'withheld-unknown-scrub' };
}

/**
 * Record a provider scrub result WITH provenance and ledger it. If the result
 * is a DNC hit, the lead is hard-flagged (one-directional).
 */
async function recordScrub(lead, { provider, result, actor }) {
  if (!providerConfigured()) {
    throw new Error('no DNC provider configured; cannot claim a scrub');
  }
  const scrub = {
    provider: String(provider),
    result: result === 'clear' ? 'clear' : 'dnc',
    scrubbedAt: new Date().toISOString(),
  };
  lead.dncScrub = scrub;
  if (scrub.result === 'dnc') lead.dnc = true;
  await ledger.append({
    type: 'dnc.scrub',
    leadId: lead.id,
    actor: actor || 'system',
    data: scrub,
  });
  return lead;
}

/**
 * Mark a lead DNC (consumer opt-out). One-directional: sets the hard flag and
 * ledgers it. There is deliberately no "unmark" primitive.
 */
async function markDnc(lead, { actor, note } = {}) {
  lead.dnc = true;
  await ledger.append({
    type: 'dnc.optout',
    leadId: lead.id,
    actor: actor || 'system',
    data: { note: note || '' },
  });
  return lead;
}

module.exports = { isCallable, recordScrub, markDnc, providerConfigured, COLD_SOURCES };
