'use strict';

/**
 * lib/routing.js — server-side lead assignment + first-touch SLA.
 *
 * ASSIGNMENT is always server-derived (never from a request body), mirroring
 * the assignedRep/actor rule the rest of the app enforces. A new lead is routed
 * to a rep by, in order:
 *   1. territory — an optional REP_TERRITORIES map ("name:zipPrefix,...") when
 *      the lead ZIP starts with a configured prefix; else
 *   2. round-robin over the rep NAMES in REP_CREDENTIALS (a persisted cursor in
 *      KV keeps the rotation even across cold starts).
 * With no reps configured, assignLead is a clean no-op (returns null) — the
 * lead simply stays unassigned.
 *
 * SLA: assignment stamps `assignedAt`. The first non-system status touch stamps
 * `firstTouchAt` (done in lib/leads.updateStatus). checkSla() computes time-to-
 * first-touch and flags `breached` once it exceeds SLA_FIRST_TOUCH_MINUTES
 * (default 60). Assignment mutates the lead + appends a `lead.assigned` ledger
 * event; it does NOT persist the lead itself — the caller (createLead) owns the
 * single write, so we never fork a parallel write path.
 */

const auth = require('./auth');
const store = require('./store');
const ledger = require('./ledger');

const RR_KEY = 'routing:rr';
const DEFAULT_SLA_MINUTES = 60;

function repNames() {
  return Array.from(auth.repCredentials().keys());
}

function hasReps() {
  return repNames().length > 0;
}

function territories() {
  const raw = process.env.REP_TERRITORIES || '';
  const out = [];
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const prefix = pair.slice(idx + 1).trim();
    if (name && prefix) out.push({ name, prefix });
  }
  return out;
}

function pickByTerritory(zip) {
  const z = String(zip || '');
  if (!z) return null;
  for (const { name, prefix } of territories()) {
    if (z.startsWith(prefix)) return name;
  }
  return null;
}

/** Advance and persist the round-robin cursor; returns the next rep name. */
async function nextRoundRobin() {
  const names = repNames();
  if (!names.length) return null;
  const cur = Number(await store.get(RR_KEY)) || 0;
  const rep = names[cur % names.length];
  // Keep the stored cursor bounded but monotonic within a rotation.
  await store.set(RR_KEY, (cur + 1) % (names.length * 1000));
  return rep;
}

/**
 * Assign a rep to `lead` SERVER-SIDE. Mutates lead.assignedRep + lead.assignedAt
 * and appends a ledger event. Returns the rep name (or null when no reps exist).
 * Does not save the lead — the caller persists.
 */
async function assignLead(lead, { actor = 'system' } = {}) {
  if (!hasReps()) return null;
  let rep = pickByTerritory(lead.zip);
  let via = 'territory';
  if (!rep) {
    rep = await nextRoundRobin();
    via = 'round-robin';
  }
  lead.assignedRep = rep;
  lead.assignedAt = new Date().toISOString();
  await ledger.append({
    type: 'lead.assigned',
    leadId: lead.id,
    actor,
    data: { rep, via },
  });
  return rep;
}

function slaThresholdMinutes() {
  const n = Number(process.env.SLA_FIRST_TOUCH_MINUTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SLA_MINUTES;
}

/**
 * Compute first-touch SLA state. Pure over (lead, now).
 * Returns { assigned, touched, minutesToTouch|minutesWaiting, breached,
 * thresholdMinutes, reason }.
 */
function checkSla(lead, { now = Date.now() } = {}) {
  const thresholdMinutes = slaThresholdMinutes();
  if (!lead || !lead.assignedAt) {
    return {
      assigned: false,
      touched: false,
      breached: false,
      minutesToTouch: null,
      thresholdMinutes,
      reason: 'unassigned',
    };
  }
  const assignedMs = Date.parse(lead.assignedAt);
  if (lead.firstTouchAt) {
    const mins = (Date.parse(lead.firstTouchAt) - assignedMs) / 60000;
    const breached = mins > thresholdMinutes;
    return {
      assigned: true,
      touched: true,
      minutesToTouch: Math.round(mins),
      breached,
      thresholdMinutes,
      reason: breached ? 'late-touch' : 'on-time',
    };
  }
  const waited = (now - assignedMs) / 60000;
  const breached = waited > thresholdMinutes;
  return {
    assigned: true,
    touched: false,
    minutesToTouch: null,
    minutesWaiting: Math.round(waited),
    breached,
    thresholdMinutes,
    reason: breached ? 'no-touch-overdue' : 'awaiting-touch',
  };
}

module.exports = {
  repNames,
  hasReps,
  territories,
  pickByTerritory,
  nextRoundRobin,
  assignLead,
  checkSla,
  slaThresholdMinutes,
  RR_KEY,
  DEFAULT_SLA_MINUTES,
};
