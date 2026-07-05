'use strict';

/**
 * test/phasee.test.js — Phase E: rep productivity (E1), consent-gated outreach
 * (E2), and billing/invoice/receipts (E3).
 *
 * Fences under test:
 *  - next-action + cadence are PURE and deterministic; the note timeline is
 *    append-only with a SERVER-stamped author (never body-supplied).
 *  - outreach HARD-BLOCKS on the DNC/consent gate, fails closed, and has NO
 *    auto-dial / auto-text / AI-voice path (asserted structurally + at runtime).
 *  - the invoice reuses the locked 20%-of-profit math, references the original
 *    hash-chained attribution, and the ledger chain stays intact throughout.
 */

process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../lib/store');
const leads = require('../lib/leads');
const ledger = require('../lib/ledger');
const consent = require('../lib/consent');
const outreach = require('../lib/outreach');
const invoice = require('../lib/invoice');
const productivity = require('../lib/productivity');
const auth = require('../lib/auth');
const server = require('../serve.local');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const BOARD = { 'X-Board-Password': 'AllisonStorm-Cmd-2026', 'Content-Type': 'application/json' };

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());
afterEach(() => {
  delete process.env.REP_CREDENTIALS;
  delete process.env.SLA_FIRST_TOUCH_MINUTES;
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
});

// ===========================================================================
// E1 — productivity pure logic + append-only note timeline
// ===========================================================================

test('E1: nextAction is deterministic and stage/SLA/claim aware', () => {
  const now = Date.now();
  // completed -> done
  assert.strictEqual(
    productivity.nextAction({ status: 'completed', assignedRep: 'a' }, { now }).urgency,
    'done'
  );
  // unclaimed -> claim it first
  const unclaimed = productivity.nextAction({ status: 'new', assignedRep: null }, { now });
  assert.strictEqual(unclaimed.reason, 'unclaimed');
  assert.strictEqual(unclaimed.action, 'Claim this lead');
  // assigned + first-touch SLA breached -> overdue beats the stage action
  const stale = { status: 'new', assignedRep: 'a', assignedAt: new Date(now - 120 * MIN).toISOString() };
  const na = productivity.nextAction(stale, { now });
  assert.strictEqual(na.urgency, 'overdue');
  // deterministic
  assert.deepStrictEqual(productivity.nextAction(stale, { now }), productivity.nextAction(stale, { now }));
  // touched + mid pipeline -> normal stage action
  const touched = {
    status: 'quoted', assignedRep: 'a',
    assignedAt: new Date(now - 200 * MIN).toISOString(),
    firstTouchAt: new Date(now - 199 * MIN).toISOString(),
  };
  assert.strictEqual(productivity.nextAction(touched, { now }).urgency, 'normal');
});

test('E1: followUpCadence flags an overdue next-touch and none for completed', () => {
  const now = Date.now();
  // fresh contacted lead, last activity 2h ago, cadence 24h -> not overdue
  const fresh = { status: 'contacted', createdAt: new Date(now - 2 * 3600 * 1000).toISOString() };
  assert.strictEqual(productivity.followUpCadence(fresh, { now }).overdue, false);
  // stale contacted lead, last activity 3 days ago -> overdue
  const stale = { status: 'contacted', createdAt: new Date(now - 3 * DAY).toISOString() };
  const c = productivity.followUpCadence(stale, { now });
  assert.strictEqual(c.overdue, true);
  assert.strictEqual(c.cadenceHours, 24);
  // completed -> no follow-up
  assert.strictEqual(productivity.followUpCadence({ status: 'completed' }, { now }).cadenceHours, null);
});

test('E1: notes are append-only with a SERVER-stamped author + time, and ledgered', async () => {
  const lead = await leads.createLead({ name: 'Noteworthy' }, { source: 'web' });
  assert.deepStrictEqual(lead.notesLog, []);
  const a = await leads.addNote(lead.id, 'called, left VM', { actor: 'alice' });
  assert.strictEqual(a.notesLog.length, 1);
  assert.strictEqual(a.notesLog[0].author, 'alice', 'author is server-stamped');
  assert.ok(a.notesLog[0].at, 'time server-stamped');
  await leads.addNote(lead.id, 'follow-up scheduled', { actor: 'alice' });
  const stored = await leads.getLead(lead.id);
  assert.strictEqual(stored.notesLog.length, 2, 'append-only — earlier note preserved');
  // ledgered
  const chain = await ledger.all();
  assert.strictEqual(chain.filter((e) => e.payload.type === 'lead.note').length, 2);
  // empty note rejected
  await assert.rejects(() => leads.addNote(lead.id, '   ', { actor: 'alice' }), /empty note/);
});

test('E1: a note via the rep PATCH path stamps the SESSION rep, never a body author', async () => {
  process.env.REP_CREDENTIALS = 'alice:secret';
  const lead = await leads.createLead({ name: 'ScopeCheck' }, { source: 'web', assignedRep: null });
  const cookie = `${auth.REP_COOKIE}=${encodeURIComponent(auth.issueRepToken('alice'))}`;
  const r = await fetch(`${base}/api/my-leads`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    // body tries to spoof the author — it must be ignored.
    body: JSON.stringify({ id: lead.id, note: 'spoof attempt', author: 'evil', actor: 'evil' }),
  });
  assert.strictEqual(r.status, 200);
  const stored = await leads.getLead(lead.id);
  assert.strictEqual(stored.notesLog[0].author, 'alice', 'author derived from session, not body');
});

// ===========================================================================
// E2 — consent-gated, human-dialed outreach (NO auto-dial / auto-text / AI voice)
// ===========================================================================

test('E2: call is BLOCKED for an unscrubbed cold lead (no auto-dial)', async () => {
  // cold storm lead, no DNC provider configured -> not callable.
  const lead = await leads.createLead({ name: 'Cold', phone: '5550001111' }, { source: 'storm' });
  const res = await outreach.attempt(lead, { channel: 'call', actor: 'alice' });
  assert.strictEqual(res.permitted, false, 'unscrubbed cold lead cannot be called');
  assert.strictEqual(res.reason, 'withheld-no-provider');
  assert.strictEqual(res.dialed, false);
  assert.strictEqual(res.sent, false);
  // blocked attempt is itself ledgered
  const chain = await ledger.all();
  assert.ok(chain.some((e) => e.payload.type === 'outreach.blocked' && e.payload.data.channel === 'call'));
});

test('E2: SMS is BLOCKED without consent, and STOP keeps it blocked (no auto-text)', async () => {
  const lead = await leads.createLead({ name: 'NoConsent', phone: '5552223333' }, { source: 'web' });
  // no consent record -> blocked
  let res = await outreach.attempt(lead, { channel: 'sms', actor: 'alice' });
  assert.strictEqual(res.permitted, false, 'no consent -> SMS blocked');
  assert.strictEqual(res.reason, 'no-consent');

  // capture consent, then STOP; opt-out must win permanently.
  await consent.recordConsent(lead.phone, { source: 'test' });
  await consent.recordOptOut(lead.phone, { via: 'sms', message: 'STOP' });
  res = await outreach.attempt(lead, { channel: 'sms', actor: 'alice' });
  assert.strictEqual(res.permitted, false, 'STOP-then-attempt stays blocked');
  assert.strictEqual(res.reason, 'sms-opted-out');
  assert.strictEqual(res.sent, false);
});

test('E2: a PERMITTED attempt LOGS the touch and stamps firstTouchAt (still dials nothing)', async () => {
  // inbound web lead carries its own express consent -> callable without a scrub.
  const lead = await leads.createLead({ name: 'Warm', phone: '5554445555' }, { source: 'web', consent: true });
  assert.strictEqual(lead.firstTouchAt, null);
  const res = await outreach.attempt(lead, { channel: 'call', actor: 'alice' });
  assert.strictEqual(res.permitted, true);
  assert.strictEqual(res.dialed, false, 'permitted != dialed — a human dials by hand');
  assert.strictEqual(res.sent, false);
  assert.ok(res.stampedFirstTouch, 'first human touch stamps the SLA clock');
  const stored = await leads.getLead(lead.id);
  assert.ok(stored.firstTouchAt, 'firstTouchAt persisted');
  const chain = await ledger.all();
  assert.ok(chain.some((e) => e.payload.type === 'outreach.attempt' && e.payload.data.channel === 'call'));
});

test('E2: there is NO auto-dial / auto-text / AI-voice code path (structural)', () => {
  // Scan EXECUTABLE code only — strip comments so the docs that describe the
  // deliberate absence of these paths don't themselves trip the check.
  const stripComments = (s) =>
    s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const outreachSrc = stripComments(fs.readFileSync(path.join(__dirname, '..', 'lib', 'outreach.js'), 'utf8'));
  const apiSrc = stripComments(fs.readFileSync(path.join(__dirname, '..', 'api', 'outreach-attempt.js'), 'utf8'));
  const both = outreachSrc + '\n' + apiSrc;
  // No outbound transport / dialer / SMS provider / AI voice in the code itself.
  for (const banned of [/fetch\s*\(/, /twilio/i, /autodial/i, /auto-dial/i, /text-to-speech/i, /\btts\b/i, /ai[-_\s]?voice/i, /dialer/i, /https?:\/\//]) {
    assert.ok(!banned.test(both), `outreach layer must not contain ${banned}`);
  }
  // the only channels are the two human channels.
  assert.deepStrictEqual([...outreach.CHANNELS].sort(), ['call', 'sms']);
});

test('E2: bad channel is rejected (400) at the endpoint', async () => {
  process.env.REP_CREDENTIALS = 'alice:secret';
  const lead = await leads.createLead({ name: 'BadCh', phone: '5556667777' }, { source: 'web', consent: true, assignedRep: null });
  const cookie = `${auth.REP_COOKIE}=${encodeURIComponent(auth.issueRepToken('alice'))}`;
  const r = await fetch(`${base}/api/outreach-attempt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: lead.id, channel: 'ai-voice' }),
  });
  assert.strictEqual(r.status, 400, 'no such channel as ai-voice');
});

// ===========================================================================
// E3 — billing / invoice / receipts
// ===========================================================================

async function wonLead(overrides = {}, meta = {}, billing = {}) {
  const lead = await leads.createLead({ name: 'Winner', phone: '5559990000', ...overrides }, { source: 'web', ...meta });
  if (billing.deliveredAt) {
    lead.deliveredAt = billing.deliveredAt;
    await leads.saveLead(lead);
  }
  await leads.updateStatus(lead.id, 'won', {
    actor: 'operator',
    collected: billing.collected ?? 9000,
    costs: billing.costs ?? 5000,
  });
  return leads.getLead(lead.id);
}

test('E3: invoice math — $9k collected − $5k costs → $800 fee (20% of profit)', async () => {
  const lead = await wonLead();
  const inv = invoice.buildInvoice(lead);
  assert.strictEqual(inv.profit, 4000);
  assert.strictEqual(inv.fee, 800);
  assert.strictEqual(inv.billable, true);
  assert.strictEqual(inv.reason, 'billable');
  assert.strictEqual(inv.lineItems[0].amount, 800);
});

test('E3: known customer invoices $0', async () => {
  const lead = await wonLead({}, { knownCustomer: true });
  const inv = invoice.buildInvoice(lead);
  assert.strictEqual(inv.fee, 0);
  assert.strictEqual(inv.reason, 'known-customer');
  assert.strictEqual(inv.billable, false);
});

test('E3: a Won outside the 90-day window invoices $0', async () => {
  const lead = await wonLead({}, {}, { deliveredAt: new Date(Date.now() - 100 * DAY).toISOString() });
  const inv = invoice.buildInvoice(lead);
  assert.strictEqual(inv.reason, 'outside-90d-window');
  assert.strictEqual(inv.fee, 0);
});

test('E3: the invoice REFERENCES the original hash-chained attribution', async () => {
  const lead = await wonLead();
  const inv = invoice.buildInvoice(lead);
  assert.strictEqual(inv.leadId, lead.id);
  assert.strictEqual(inv.attribution.token, lead.attribution.token, 'cites the lead attribution token');
  assert.strictEqual(inv.attribution.serverStamped, true);
  assert.ok(leads.hasValidAttribution(lead));
});

test('E3: paymentStatus transitions unpaid→paid via the operator PATCH path; ledger verifyChain still holds', async () => {
  const lead = await wonLead();
  assert.strictEqual(lead.paymentStatus, 'unpaid');
  const r = await fetch(`${base}/api/board`, {
    method: 'PATCH', headers: BOARD,
    body: JSON.stringify({ id: lead.id, paymentStatus: 'paid' }),
  });
  assert.strictEqual(r.status, 200);
  const stored = await leads.getLead(lead.id);
  assert.strictEqual(stored.paymentStatus, 'paid');
  // ledgered payment transition
  const chain = await ledger.all();
  assert.ok(chain.some((e) => e.payload.type === 'lead.payment' && e.payload.data.to === 'paid'));
  // hash chain intact across all E3 writes
  const verdict = ledger.verifyChain(chain);
  assert.strictEqual(verdict.valid, true, 'hash chain intact after invoice/payment flow');
  // invoice reflects the new payment state
  assert.strictEqual(invoice.buildInvoice(stored).paymentStatus, 'paid');
});

test('E3: an invalid paymentStatus is rejected (400) and a non-won lead has no invoice (409)', async () => {
  const lead = await leads.createLead({ name: 'Open' }, { source: 'web' });
  let r = await fetch(`${base}/api/board`, {
    method: 'PATCH', headers: BOARD, body: JSON.stringify({ id: lead.id, paymentStatus: 'refunded' }),
  });
  assert.strictEqual(r.status, 400);
  r = await fetch(`${base}/api/invoice?id=${lead.id}`, { headers: BOARD });
  assert.strictEqual(r.status, 409, 'not-won lead has no invoice');
});

test('E3: the receipt is INTERNAL-only and fail-safe (no-op without config, never throws)', async () => {
  const notify = require('../lib/notify');
  assert.strictEqual(notify.configured(), false);
  const lead = await wonLead();
  const res = await notify.notifyReceipt(lead);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.reason, 'no-config');
});
