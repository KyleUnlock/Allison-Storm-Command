'use strict';

/**
 * lib/productivity.js — E1 rep-productivity PURE logic (unit-testable).
 *
 * Two deterministic derivations the rep console (and the operator surfaces)
 * render, plus a small activity helper they share:
 *   - nextAction(lead, {now})     -> the single most useful next step, derived
 *                                    from stage + first-touch SLA + claim ladder.
 *   - followUpCadence(lead, {now})-> suggested next-touch time by stage, and
 *                                    whether that touch is now overdue.
 *
 * Nothing here mutates, stores, or sends. It is a read-only view over lead
 * state so the same numbers can be computed server-side (api views) and shown
 * client-side without a second source of truth.
 */

const routing = require('./routing');

// Suggested hours between touches, by pipeline stage. `completed` has no
// follow-up (null). Fresh 'new' leads get the tightest cadence.
const STAGE_CADENCE_HOURS = {
  new: 1,
  contacted: 24,
  inspection: 24,
  inspected: 48,
  quoted: 48,
  negotiation: 72,
  won: 120,
  production: 168,
  completed: null,
};

// The default next step for each stage (used when no SLA/claim override wins).
const STAGE_ACTION = {
  new: 'Make first contact and confirm reported storm damage',
  contacted: 'Schedule the roof inspection',
  inspection: 'Complete the on-site inspection',
  inspected: 'Prepare and send the quote',
  quoted: 'Follow up on the quote',
  negotiation: 'Close and collect the signed agreement',
  won: 'Start production scheduling',
  production: 'Track production to completion',
  completed: 'Complete — no action needed',
};

/**
 * Epoch-ms of the most recent activity on a lead: createdAt, first touch, any
 * history transition, or any timeline note — whichever is latest. Pure.
 */
function lastActivityAt(lead) {
  if (!lead) return NaN;
  const times = [];
  if (lead.createdAt) times.push(Date.parse(lead.createdAt));
  if (lead.firstTouchAt) times.push(Date.parse(lead.firstTouchAt));
  for (const h of lead.history || []) if (h && h.at) times.push(Date.parse(h.at));
  for (const n of lead.notesLog || []) if (n && n.at) times.push(Date.parse(n.at));
  const valid = times.filter((t) => Number.isFinite(t));
  return valid.length ? Math.max(...valid) : NaN;
}

/**
 * The single next action a rep should take on a lead. Precedence:
 *   1. completed        -> done, nothing to do.
 *   2. unclaimed        -> claim it first.
 *   3. first-touch SLA  -> overdue beats everything actionable; awaiting-touch
 *                          raises the stage action to "due".
 *   4. mid-ladder claim -> nudge toward the adjuster/supplement work.
 *   5. otherwise        -> the stage default.
 * Returns { action, urgency: 'overdue'|'due'|'normal'|'done', reason }.
 */
function nextAction(lead, { now = Date.now() } = {}) {
  if (!lead) return { action: '—', urgency: 'normal', reason: 'no-lead' };

  const stage = lead.status;
  if (stage === 'completed') {
    return { action: STAGE_ACTION.completed, urgency: 'done', reason: 'completed' };
  }
  if (!lead.assignedRep) {
    return { action: 'Claim this lead', urgency: 'due', reason: 'unclaimed' };
  }

  const base = STAGE_ACTION[stage] || 'Review this lead';
  const sla = routing.checkSla(lead, { now });
  if (sla.assigned && !sla.touched) {
    if (sla.breached) {
      return { action: 'Overdue — make first contact now', urgency: 'overdue', reason: 'sla-breached' };
    }
    return { action: base, urgency: 'due', reason: 'awaiting-first-touch' };
  }

  const claimStatus = lead.claim && lead.claim.status;
  if (claimStatus === 'inspection_scheduled') {
    return { action: 'Attend the scheduled adjuster inspection', urgency: 'due', reason: 'claim-inspection' };
  }
  if (claimStatus === 'supplement') {
    return { action: 'Submit and track the insurance supplement', urgency: 'due', reason: 'claim-supplement' };
  }

  return { action: base, urgency: 'normal', reason: 'stage' };
}

/**
 * Suggested follow-up cadence for a lead. Anchors off the last activity and
 * flags an overdue next-touch. `completed` (and unknown stages) return a null
 * cadence with overdue:false. Pure over (lead, now).
 * Returns { cadenceHours, lastActivityAt, nextTouchAt, overdue, hoursUntilDue,
 * reason }.
 */
function followUpCadence(lead, { now = Date.now() } = {}) {
  const stage = lead && lead.status;
  const hours = Object.prototype.hasOwnProperty.call(STAGE_CADENCE_HOURS, stage)
    ? STAGE_CADENCE_HOURS[stage]
    : undefined;

  if (hours == null) {
    return {
      cadenceHours: null,
      lastActivityAt: null,
      nextTouchAt: null,
      overdue: false,
      hoursUntilDue: null,
      reason: stage === 'completed' ? 'no-followup' : 'unknown-stage',
    };
  }

  const last = lastActivityAt(lead);
  const anchor = Number.isFinite(last) ? last : now;
  const nextTouch = anchor + hours * 3600 * 1000;
  const overdue = now > nextTouch;
  return {
    cadenceHours: hours,
    lastActivityAt: new Date(anchor).toISOString(),
    nextTouchAt: new Date(nextTouch).toISOString(),
    overdue,
    hoursUntilDue: Math.round((nextTouch - now) / 3600000),
    reason: overdue ? 'overdue' : 'scheduled',
  };
}

module.exports = {
  STAGE_CADENCE_HOURS,
  STAGE_ACTION,
  lastActivityAt,
  nextAction,
  followUpCadence,
};
