'use strict';

/**
 * lib/leads.js — lead lifecycle, billing, attribution, 90-day clamp.
 *
 * LOCKED billing rule: the platform fee is 20% of PROFIT — collected revenue
 * minus direct job costs (canonical wording lives in lib/deal-terms.js). It is
 * never a cut of gross and never a larger percentage. A job bills only when ALL
 * hold:
 *   - the lead is NOT a known customer (known customer bills $0),
 *   - the Won references an original, server-stamped, hash-chained lead
 *     (strict attribution),
 *   - the (server-clamped) Won sign date falls inside the 90-day window.
 *
 * Profit = collected - direct job costs. Fee = round(profit * 0.20).
 */

const crypto = require('crypto');
const store = require('./store');
const ledger = require('./ledger');
const sanitize = require('./sanitize');
const scoring = require('./scoring');
const routing = require('./routing');
const notify = require('./notify');

const COMMISSION_RATE = 0.2; // 20% of PROFIT. Hard requirement.
const WINDOW_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// 9 CRM kanban stages, in order.
const STAGES = [
  'new',
  'contacted',
  'inspection',
  'inspected',
  'quoted',
  'negotiation',
  'won',
  'production',
  'completed',
];
const STAGE_SET = new Set(STAGES);

// Insurance claim milestone ladder (C1). Ordered filing -> resolution.
const CLAIM_STATUSES = [
  'filed',
  'inspection_scheduled',
  'approved',
  'supplement',
  'paid',
  'denied',
];
const CLAIM_STATUS_SET = new Set(CLAIM_STATUSES);

// KV keys.
const leadKey = (id) => `lead:${id}`;
const INDEX_KEY = 'leads:index';

function newId() {
  return `ld_${crypto.randomBytes(8).toString('hex')}`;
}

function clampTime(t, lo, hi) {
  return Math.min(Math.max(t, lo), hi);
}

/**
 * Coerce a money field. Absent/empty (null/undefined/'') is a legitimate 0 — a
 * signed-but-not-yet-collected Win is a valid $0 state. Anything else is passed
 * through Number(): a non-numeric string (e.g. "5,000" with a comma) becomes
 * NaN and is caught by the validAmounts guard so it can never yield a NaN fee.
 */
function moneyAmount(v) {
  if (v == null || v === '') return 0;
  return Number(v);
}

/**
 * Sanitize a server-supplied campaign/attribution tag (paid-play ad sources).
 * Shallow object of small identifiers; string values are injection-scrubbed,
 * finite numbers pass through (cost/click ids for the later analytics phase).
 * Empty/absent values are dropped. Returns null when nothing survives.
 */
function cleanCampaign(campaign) {
  if (!campaign || typeof campaign !== 'object') return null;
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(campaign)) {
    if (rawVal == null || rawVal === '') continue;
    const key = sanitize.cleanString(rawKey, 60);
    if (!key) continue;
    out[key] =
      typeof rawVal === 'number' && Number.isFinite(rawVal)
        ? rawVal
        : sanitize.cleanString(rawVal, 200);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Create a lead. The server stamps id, source, timestamps, and the strict
 * attribution token — this stamp is what a later Won must reference to bill.
 *
 * `input` is already-sanitized public/rep fields. `meta` carries server-only
 * facts (source, assignedRep, knownCustomer) that callers must NOT trust from
 * the request body.
 */
async function createLead(input = {}, meta = {}) {
  const now = Date.now();
  const id = newId();
  const nowIso = new Date(now).toISOString();

  const lead = {
    id,
    source: meta.source || 'web',
    // Paid-play ad attribution (Phase D). adSource ∈ {meta, callrail, lsa, ...};
    // campaign carries source-ROI + cost/click ids for the later analytics phase.
    adSource: meta.adSource ? sanitize.cleanString(meta.adSource, 40) : null,
    campaign: cleanCampaign(meta.campaign),
    status: 'new',
    // contact
    name: sanitize.cleanString(input.name, 120),
    phone: sanitize.cleanPhone(input.phone),
    email: sanitize.cleanEmail(input.email),
    zip: sanitize.cleanZip(input.zip),
    address: sanitize.cleanString(input.address, 200),
    notes: sanitize.cleanString(input.notes, 1000),
    // flags (server-controlled)
    knownCustomer: meta.knownCustomer === true,
    consent: meta.consent === true,
    dnc: false,
    dncScrub: null,
    assignedRep: meta.assignedRep || null,
    assignedAt: null, // stamped by routing.assignLead (SLA anchor).
    firstTouchAt: null, // stamped on first non-system status touch (SLA).
    claim: null, // insurance claim ladder (C1); set via updateClaim.
    notesLog: [], // append-only note timeline (E1); server-stamps author + time.
    paymentStatus: 'unpaid', // invoice payment state (E3): unpaid|paid.
    // strict, server-stamped attribution — the anchor a Won must reference.
    attribution: {
      token: crypto.createHash('sha256').update(id + nowIso).digest('hex'),
      serverStamped: true,
      stampedAt: nowIso,
    },
    createdAt: nowIso,
    deliveredAt: nowIso, // window anchor: lead delivered to Allison now.
    won: null,
    history: [{ status: 'new', at: nowIso, actor: meta.assignedRep || 'system' }],
  };

  // Deterministic priority score at creation (C2). Advisory only — never
  // affects callability, attribution, or billing.
  lead.score = scoring.scoreLead(lead, { now });

  await store.set(leadKey(id), lead);
  // If the index push (or ledger append) fails after the value write, roll the
  // value back so no orphaned, unindexed lead lingers invisibly in the store.
  // A dangling index id (value deleted but id pushed) is harmless — listLeads
  // null-skips missing values.
  try {
    await store.listPush(INDEX_KEY, id);
    await ledger.append({
      type: 'lead.created',
      leadId: id,
      actor: meta.assignedRep || 'system',
      data: {
        source: lead.source,
        adSource: lead.adSource || null,
        attribution: lead.attribution.token,
      },
    });
  } catch (e) {
    try {
      await store.del(leadKey(id));
    } catch {
      /* best-effort cleanup; surface the original failure below */
    }
    throw e;
  }

  // Server-side routing (C3): assign a rep when none was pre-set and reps are
  // configured. assignLead mutates lead + ledgers; we persist the result here.
  if (!lead.assignedRep && routing.hasReps()) {
    await routing.assignLead(lead, { actor: 'system' });
    await store.set(leadKey(id), lead);
  }

  // Fail-safe internal notification (C3): no-ops without RESEND/NOTIFY env and
  // never throws, so it can never block the lead write.
  await notify.notifyNewLead(lead);

  return lead;
}

async function getLead(id) {
  if (!id) return null;
  return store.get(leadKey(id));
}

async function saveLead(lead) {
  await store.set(leadKey(lead.id), lead);
  return lead;
}

async function listLeads() {
  const ids = await store.listRange(INDEX_KEY);
  const out = [];
  for (const id of ids) {
    const lead = await store.get(leadKey(id));
    if (lead) out.push(lead);
  }
  return out;
}

/**
 * Strict attribution check: bills only when the lead carries the original,
 * server-stamped attribution token.
 */
function hasValidAttribution(lead) {
  return Boolean(
    lead &&
      lead.attribution &&
      lead.attribution.serverStamped === true &&
      typeof lead.attribution.token === 'string' &&
      lead.attribution.token.length > 0
  );
}

/**
 * Pure fee computation. Returns a billing breakdown. `serverNow` and the raw
 * `contractDate` are epoch ms; contractDate is CLAMPED to [deliveredAt,
 * serverNow] on BOTH ends so a caller cannot pass a future date to dodge (or a
 * past date to fake) the share.
 */
function computeBilling(lead, { collected, costs, contractDate, serverNow }) {
  const deliveredAt = Date.parse(lead.deliveredAt);
  const requested = Number.isFinite(contractDate) ? contractDate : serverNow;
  const clampedSign = clampTime(requested, deliveredAt, serverNow);
  const windowEnd = deliveredAt + WINDOW_DAYS * DAY_MS;

  // Fail-closed money coercion: a non-numeric string or a negative amount can
  // never produce a NaN/inflated fee. Bad input -> fee 0, reason 'invalid-
  // amounts', forcing the operator to re-enter clean numbers.
  const cNum = moneyAmount(collected);
  const kNum = moneyAmount(costs);
  const validAmounts =
    Number.isFinite(cNum) && cNum >= 0 && Number.isFinite(kNum) && kNum >= 0;
  const profit = validAmounts ? Math.max(0, cNum - kNum) : 0;
  const inWindow = clampedSign >= deliveredAt && clampedSign <= windowEnd;

  let fee = 0;
  let reason = 'billable';
  if (lead.knownCustomer) {
    reason = 'known-customer';
  } else if (!hasValidAttribution(lead)) {
    reason = 'no-attribution';
  } else if (!inWindow) {
    reason = 'outside-90d-window';
  } else if (!validAmounts) {
    reason = 'invalid-amounts';
  } else if (profit <= 0) {
    reason = 'no-profit';
  } else {
    fee = Math.round(profit * COMMISSION_RATE * 100) / 100;
  }

  return {
    // Never surface NaN into the record/invoice.
    collected: Number.isFinite(cNum) ? cNum : 0,
    costs: Number.isFinite(kNum) ? kNum : 0,
    profit,
    fee,
    commissionRate: COMMISSION_RATE,
    reason,
    contractDate: new Date(clampedSign).toISOString(),
    contractDateRequested: new Date(requested).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    clamped: clampedSign !== requested,
  };
}

/**
 * Move a lead to a new status. Server owns actor + timestamps. Moving to
 * 'won' requires billing opts (collected, costs, contractDate) and computes
 * the fee via computeBilling (with the 90-day clamp). No caller-supplied
 * actor/assignedRep is trusted here.
 */
async function updateStatus(id, status, opts = {}) {
  if (!STAGE_SET.has(status)) {
    const err = new Error(`invalid status: ${status}`);
    err.code = 'BAD_STATUS';
    throw err;
  }
  const lead = await getLead(id);
  if (!lead) {
    const err = new Error('lead not found');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const serverNow = Date.now();
  const nowIso = new Date(serverNow).toISOString();
  const actor = opts.actor || 'system';

  // SLA first-touch (C3): the first human (non-system) action stamps the clock
  // used by routing.checkSla. Set once, never overwritten.
  if (!lead.firstTouchAt && actor && actor !== 'system') {
    lead.firstTouchAt = nowIso;
  }

  lead.status = status;
  lead.history = lead.history || [];
  lead.history.push({ status, at: nowIso, actor });

  if (status === 'won') {
    const requested =
      opts.contractDate != null ? Date.parse(opts.contractDate) : serverNow;
    lead.won = computeBilling(lead, {
      collected: opts.collected,
      costs: opts.costs,
      contractDate: requested,
      serverNow,
    });
    lead.won.wonAt = nowIso;
  }

  await saveLead(lead);
  await ledger.append({
    type: 'lead.status',
    leadId: id,
    actor,
    data: { status, won: lead.won || null },
  });
  return lead;
}

/**
 * C1 — update the insurance claim ladder on a lead via the EXISTING PATCH path
 * (the api/board + api/my-leads handlers, which already enforce operator/rep
 * scoping). Partial updates are allowed; string fields are sanitized and the
 * milestone `status` is validated against CLAIM_STATUSES. Server owns actor +
 * timestamps. Does not touch attribution, billing, or callability.
 */
async function updateClaim(id, claimInput = {}, opts = {}) {
  const lead = await getLead(id);
  if (!lead) {
    const err = new Error('lead not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const actor = opts.actor || 'system';
  const next = { ...(lead.claim || {}) };

  if (claimInput.carrier !== undefined) {
    next.carrier = sanitize.cleanString(claimInput.carrier, 120);
  }
  if (claimInput.claimNumber !== undefined) {
    next.claimNumber = sanitize.cleanString(claimInput.claimNumber, 60);
  }
  if (claimInput.adjuster !== undefined) {
    next.adjuster = sanitize.cleanString(claimInput.adjuster, 120);
  }
  if (claimInput.status !== undefined) {
    const s = String(claimInput.status);
    if (!CLAIM_STATUS_SET.has(s)) {
      const err = new Error(`invalid claim status: ${s}`);
      err.code = 'BAD_CLAIM_STATUS';
      throw err;
    }
    next.status = s;
  }
  next.updatedAt = new Date().toISOString();

  lead.claim = next;
  await saveLead(lead);
  await ledger.append({
    type: 'lead.claim',
    leadId: id,
    actor,
    data: { status: next.status || null, carrier: next.carrier || null },
  });
  return lead;
}

/**
 * Operator assignment lever: set (or clear) a lead's assignedRep from the
 * operator-scoped PATCH path. This is distinct from a REP setting arbitrary
 * assignment (still blocked) — an authenticated operator directing their own
 * field team is legitimate authority. The target is validated against the
 * configured reps so an operator cannot assign to a nonexistent rep; passing an
 * empty value unassigns. Server owns actor + timestamp; the change is ledgered.
 */
async function setAssignedRep(id, repName, opts = {}) {
  const lead = await getLead(id);
  if (!lead) {
    const err = new Error('lead not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const rep = String(repName || '').trim();
  if (rep && !new Set(routing.repNames()).has(rep)) {
    const err = new Error(`unknown rep: ${rep}`);
    err.code = 'BAD_REP';
    throw err;
  }
  const actor = opts.actor || 'operator';
  lead.assignedRep = rep || null;
  // First assignment stamps the SLA clock; a reassignment keeps the original.
  if (rep && !lead.assignedAt) lead.assignedAt = new Date().toISOString();
  await saveLead(lead);
  await ledger.append({
    type: 'lead.assigned',
    leadId: id,
    actor,
    data: { rep: rep || null, via: 'operator' },
  });
  return lead;
}

// Allowed invoice payment states (E3).
const PAYMENT_STATUSES = ['unpaid', 'paid'];
const PAYMENT_STATUS_SET = new Set(PAYMENT_STATUSES);

/**
 * E1 — append a note to a lead's append-only timeline via the SAME rep/
 * operator-scoped PATCH path. Author + timestamp are SERVER-stamped (never from
 * the body); the text is sanitized. There is deliberately no edit/delete
 * primitive — the timeline is append-only and every add is ledgered.
 */
async function addNote(id, text, opts = {}) {
  const lead = await getLead(id);
  if (!lead) {
    const err = new Error('lead not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const clean = sanitize.cleanString(text, 2000);
  if (!clean) {
    const err = new Error('empty note');
    err.code = 'EMPTY_NOTE';
    throw err;
  }
  const actor = opts.actor || 'system';
  const note = { text: clean, author: actor, at: new Date().toISOString() };
  lead.notesLog = lead.notesLog || [];
  lead.notesLog.push(note);
  await saveLead(lead);
  await ledger.append({
    type: 'lead.note',
    leadId: id,
    actor,
    data: { author: actor, len: clean.length },
  });
  return lead;
}

/**
 * E3 — transition a lead's invoice paymentStatus (unpaid|paid) via the existing
 * operator-scoped PATCH path. Server owns actor + timestamp; the transition is
 * ledgered. When a lead is newly marked `paid`, a fail-safe INTERNAL receipt is
 * fired via lib/notify (NOTIFY_TO only — never a homeowner). Attribution and
 * billing math are untouched here.
 */
async function setPaymentStatus(id, status, opts = {}) {
  const s = String(status);
  if (!PAYMENT_STATUS_SET.has(s)) {
    const err = new Error(`invalid payment status: ${s}`);
    err.code = 'BAD_PAYMENT_STATUS';
    throw err;
  }
  const lead = await getLead(id);
  if (!lead) {
    const err = new Error('lead not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const actor = opts.actor || 'system';
  const prev = lead.paymentStatus || 'unpaid';
  lead.paymentStatus = s;
  lead.paymentStatusAt = new Date().toISOString();
  await saveLead(lead);
  await ledger.append({
    type: 'lead.payment',
    leadId: id,
    actor,
    data: { from: prev, to: s },
  });
  // Internal-only receipt on the unpaid->paid transition; fail-safe, never
  // blocks the write, never addresses a homeowner.
  if (s === 'paid' && prev !== 'paid') {
    try {
      await notify.notifyReceipt(lead);
    } catch {
      /* non-blocking: a notify failure must never fail the payment write */
    }
  }
  return lead;
}

module.exports = {
  COMMISSION_RATE,
  WINDOW_DAYS,
  STAGES,
  STAGE_SET,
  CLAIM_STATUSES,
  CLAIM_STATUS_SET,
  PAYMENT_STATUSES,
  PAYMENT_STATUS_SET,
  createLead,
  getLead,
  saveLead,
  listLeads,
  updateStatus,
  updateClaim,
  addNote,
  setPaymentStatus,
  setAssignedRep,
  computeBilling,
  hasValidAttribution,
  INDEX_KEY,
  leadKey,
};
