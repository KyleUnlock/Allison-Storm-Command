'use strict';

// Env for the server-backed PATCH-path tests. Set BEFORE requiring handlers.
process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const leads = require('../lib/leads');
const ledger = require('../lib/ledger');
const scoring = require('../lib/scoring');
const dedupe = require('../lib/dedupe');
const routing = require('../lib/routing');
const notify = require('../lib/notify');
const server = require('../serve.local');

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
  delete process.env.REP_TERRITORIES;
  delete process.env.SLA_FIRST_TOUCH_MINUTES;
  delete process.env.RESEND_API_KEY;
  delete process.env.NOTIFY_TO;
});

// ---------------------------------------------------------------------------
// C1 — insurance claim ladder
// ---------------------------------------------------------------------------

test('C1: a claim milestone persists through the operator /api/board PATCH path', async () => {
  const lead = await leads.createLead({ name: 'ClaimGuy', phone: '5551230000' }, { source: 'web' });
  const r = await fetch(`${base}/api/board`, {
    method: 'PATCH',
    headers: BOARD,
    body: JSON.stringify({
      id: lead.id,
      claim: { carrier: 'Acme Mutual', claimNumber: 'CLM-42', adjuster: 'Pat', status: 'filed' },
    }),
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.lead.claim.status, 'filed');
  assert.strictEqual(body.lead.claim.carrier, 'Acme Mutual');

  // Advance the milestone; the stored ladder reflects the new state.
  await fetch(`${base}/api/board`, {
    method: 'PATCH', headers: BOARD,
    body: JSON.stringify({ id: lead.id, claim: { status: 'approved' } }),
  });
  const stored = await leads.getLead(lead.id);
  assert.strictEqual(stored.claim.status, 'approved');
  assert.strictEqual(stored.claim.claimNumber, 'CLM-42', 'earlier fields preserved on partial update');
});

test('C1: an invalid claim status is rejected (400)', async () => {
  const lead = await leads.createLead({ name: 'Bad' }, { source: 'web' });
  const r = await fetch(`${base}/api/board`, {
    method: 'PATCH', headers: BOARD,
    body: JSON.stringify({ id: lead.id, claim: { status: 'not-a-milestone' } }),
  });
  assert.strictEqual(r.status, 400);
});

test('C1: the board view surfaces the claim (no detection-without-display)', async () => {
  const lead = await leads.createLead({ name: 'Shown' }, { source: 'web' });
  await leads.updateClaim(lead.id, { status: 'inspection_scheduled' }, { actor: 'operator' });
  const d = await (await fetch(`${base}/api/board`, { headers: BOARD })).json();
  const row = d.leads.find((l) => l.id === lead.id);
  assert.ok(row.claim, 'claim present on board view');
  assert.strictEqual(row.claim.status, 'inspection_scheduled');
});

// ---------------------------------------------------------------------------
// C2 — scoring + dedupe + enrichment
// ---------------------------------------------------------------------------

test('C2: score is deterministic for the same lead + clock', () => {
  const lead = { source: 'web', zip: '77002', deliveredAt: new Date().toISOString() };
  const now = Date.now();
  assert.strictEqual(scoring.scoreLead(lead, { now }), scoring.scoreLead(lead, { now }));
});

test('C2: score orders sensibly — hail+web+fresh beats no-storm+ad+fresh', () => {
  const now = Date.now();
  const hot = { source: 'web', zip: '77002', deliveredAt: new Date(now).toISOString() }; // reported hail
  const cold = { source: 'ad', zip: '00000', deliveredAt: new Date(now).toISOString() }; // no report
  const sHot = scoring.scoreLead(hot, { now });
  const sCold = scoring.scoreLead(cold, { now });
  assert.ok(sHot > sCold, `expected ${sHot} > ${sCold}`);
  assert.ok(sHot >= 0 && sHot <= 100 && sCold >= 0 && sCold <= 100);
});

test('C2: a new lead gets a score at creation', async () => {
  const lead = await leads.createLead({ name: 'Scored', zip: '77002' }, { source: 'web' });
  assert.strictEqual(typeof lead.score, 'number');
  assert.ok(lead.score > 0);
});

test('C2: duplicates are detected by normalized phone + address', () => {
  // Same phone (punctuation stripped) + same address (case/punct normalized).
  const a = { phone: '(555) 111-2222', address: '100 Main St.' };
  const b = { phone: '5551112222', address: '100  MAIN st' };
  assert.strictEqual(dedupe.isDuplicate(a, b), true);
  // Different phone -> not a duplicate even at the same address.
  assert.strictEqual(dedupe.isDuplicate(a, { phone: '5559999999', address: '100 Main St.' }), false);
  // Empty key (no phone, no address) is never a duplicate.
  assert.strictEqual(dedupe.isDuplicate({}, {}), false);
});

test('C2: merge keeps the earliest lead id + attribution and ledger.verifyChain() still holds', async () => {
  // First (survivor) lead.
  const first = await leads.createLead({ name: 'First', phone: '5551110000', address: '200 Oak Ave' }, { source: 'web' });
  // Force a strictly-later stamp on the duplicate so ordering is deterministic.
  const second = await leads.createLead({ name: 'Second', phone: '5551110000', address: '200 oak ave', email: 'x@y.com' }, { source: 'ad' });
  second.attribution.stampedAt = new Date(Date.parse(first.attribution.stampedAt) + 5000).toISOString();
  await leads.saveLead(second);

  assert.strictEqual(dedupe.isDuplicate(first, second), true);

  // Merge in swapped order to prove ordering is by stamp, not argument order.
  const { primary } = await dedupe.mergeAndPersist(second, first, { actor: 'operator' });
  assert.strictEqual(primary.id, first.id, 'survivor is the earliest server-stamped lead');
  assert.strictEqual(primary.attribution.token, first.attribution.token, 'attribution token preserved');
  // enrichment: primary gained the secondary's email without overwriting anything.
  assert.strictEqual(primary.email, 'x@y.com');

  const chain = await ledger.all();
  assert.ok(chain.some((e) => e.payload.type === 'lead.merged'), 'merge is ledgered');
  const verdict = ledger.verifyChain(chain);
  assert.strictEqual(verdict.valid, true, 'hash chain intact after dedupe-merge');
});

// ---------------------------------------------------------------------------
// C3 — routing + SLA + notify
// ---------------------------------------------------------------------------

test('C3: assignment is server-set and round-robins over configured reps', async () => {
  process.env.REP_CREDENTIALS = 'alice:secret,bob:secret,carol:secret';
  // Body cannot set assignedRep; createLead auto-assigns server-side.
  const a = await leads.createLead({ name: 'A' }, { source: 'web', assignedRep: null });
  const b = await leads.createLead({ name: 'B' }, { source: 'web', assignedRep: null });
  const c = await leads.createLead({ name: 'C' }, { source: 'web', assignedRep: null });
  const d = await leads.createLead({ name: 'D' }, { source: 'web', assignedRep: null });
  assert.deepStrictEqual(
    [a.assignedRep, b.assignedRep, c.assignedRep, d.assignedRep],
    ['alice', 'bob', 'carol', 'alice'],
    'round-robin rotation over rep names'
  );
  assert.ok(a.assignedAt, 'assignedAt stamped server-side');
});

test('C3: territory routing takes precedence over round-robin when ZIP matches', async () => {
  process.env.REP_CREDENTIALS = 'alice:secret,bob:secret';
  process.env.REP_TERRITORIES = 'bob:770'; // Houston prefix — matches 77002
  const lead = await leads.createLead({ name: 'Terr', zip: '77002' }, { source: 'web' });
  assert.strictEqual(lead.assignedRep, 'bob');
});

test('C3: SLA breach flips after the threshold and clears once touched in time', () => {
  process.env.SLA_FIRST_TOUCH_MINUTES = '60';
  const now = Date.now();
  const fresh = { assignedAt: new Date(now - 10 * MIN).toISOString() };
  assert.strictEqual(routing.checkSla(fresh, { now }).breached, false, '10m in -> not breached');

  const stale = { assignedAt: new Date(now - 61 * MIN).toISOString() };
  assert.strictEqual(routing.checkSla(stale, { now }).breached, true, '61m with no touch -> breached');

  const touched = {
    assignedAt: new Date(now - 200 * MIN).toISOString(),
    firstTouchAt: new Date(now - 200 * MIN + 5 * MIN).toISOString(),
  };
  assert.strictEqual(routing.checkSla(touched, { now }).breached, false, 'touched within 5m -> on-time');
});

test('C3: first rep touch stamps firstTouchAt (SLA clock stops)', async () => {
  process.env.REP_CREDENTIALS = 'alice:secret';
  const lead = await leads.createLead({ name: 'Touch' }, { source: 'web' });
  assert.strictEqual(lead.firstTouchAt, null);
  const moved = await leads.updateStatus(lead.id, 'contacted', { actor: 'alice' });
  assert.ok(moved.firstTouchAt, 'first non-system touch stamped');
});

test('C3: notify no-ops without RESEND/NOTIFY env and never throws', async () => {
  assert.strictEqual(notify.configured(), false);
  const lead = await leads.createLead({ name: 'NoNotify' }, { source: 'web' });
  const resNew = await notify.notifyNewLead(lead);
  assert.strictEqual(resNew.sent, false);
  assert.strictEqual(resNew.reason, 'no-config');
  const resSla = await notify.notifySlaBreach(lead);
  assert.strictEqual(resSla.sent, false);
  assert.strictEqual(resSla.reason, 'no-config');
});
