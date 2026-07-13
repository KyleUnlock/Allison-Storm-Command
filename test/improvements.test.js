'use strict';

/**
 * test/improvements.test.js — locks the hardening fixes from the 2026-07 audit:
 * billing input validation, ledger concurrency + tail-truncation evidence,
 * operator rep assignment, rep-token forgery rejection, DNC no-provider throw,
 * and the login rate limiter. All offline over the in-memory store.
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const ledger = require('../lib/ledger');
const leads = require('../lib/leads');
const auth = require('../lib/auth');
const dnc = require('../lib/dnc');
const rl = require('../lib/ratelimit');

beforeEach(() => store._resetMemory());

// ---- #1 billing input validation --------------------------------------------

function billableLead() {
  return {
    deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    knownCustomer: false,
    attribution: { serverStamped: true, token: 'tok' },
  };
}

test('computeBilling: comma/non-numeric collected -> invalid-amounts, fee 0, no NaN', () => {
  const r = leads.computeBilling(billableLead(), { collected: '5,000', costs: 1000, serverNow: Date.now() });
  assert.strictEqual(r.reason, 'invalid-amounts');
  assert.strictEqual(r.fee, 0);
  assert.ok(Number.isFinite(r.collected) && Number.isFinite(r.costs), 'never NaN in the record');
});

test('computeBilling: negative costs -> invalid-amounts, never an inflated fee', () => {
  const r = leads.computeBilling(billableLead(), { collected: 9000, costs: -100000, serverNow: Date.now() });
  assert.strictEqual(r.reason, 'invalid-amounts');
  assert.strictEqual(r.fee, 0);
});

test('computeBilling: absent amounts stay a valid $0 (no-profit), not invalid', () => {
  const r = leads.computeBilling(billableLead(), { collected: null, costs: '', serverNow: Date.now() });
  assert.strictEqual(r.reason, 'no-profit');
  assert.strictEqual(r.fee, 0);
});

test('computeBilling: collected <= costs -> no-profit (the untested branch)', () => {
  const r = leads.computeBilling(billableLead(), { collected: 5000, costs: 9000, serverNow: Date.now() });
  assert.strictEqual(r.profit, 0);
  assert.strictEqual(r.fee, 0);
  assert.strictEqual(r.reason, 'no-profit');
});

test('computeBilling: clean billable still bills 20% of profit ($9k-$5k -> $800)', () => {
  const r = leads.computeBilling(billableLead(), { collected: 9000, costs: 5000, serverNow: Date.now() });
  assert.strictEqual(r.reason, 'billable');
  assert.strictEqual(r.fee, 800);
});

// ---- #2/#3 ledger concurrency + truncation ----------------------------------

test('ledger: concurrent appends serialize (no forked chain, no false tamper)', async () => {
  await Promise.all(
    Array.from({ length: 8 }, (_, i) => ledger.append({ type: 'test', n: i }))
  );
  const chain = await store.listRange('ledger');
  assert.strictEqual(chain.length, 8);
  assert.strictEqual((await ledger.verify()).valid, true, 'chain intact after concurrent appends');
});

test('ledger: head commitment detects tail truncation of a valid prefix', async () => {
  for (let i = 0; i < 3; i += 1) await ledger.append({ type: 'test', n: i });
  const head = await ledger.head();
  const chain = await store.listRange('ledger');
  // Drop the newest entry — the surviving prefix still hash-verifies on its own.
  await store.set('ledger', chain.slice(0, chain.length - 1));
  const bare = ledger.verifyChain(await store.listRange('ledger')); // no head -> unanchored
  assert.strictEqual(bare.valid, true, 'prefix alone looks intact (the gap)');
  const anchored = ledger.verifyChain(await store.listRange('ledger'), head);
  assert.strictEqual(anchored.valid, false);
  assert.strictEqual(anchored.reason, 'truncated');
});

test('ledger: prevHash-linkage break (deleted middle entry) is detected', async () => {
  for (let i = 0; i < 3; i += 1) await ledger.append({ type: 'test', n: i });
  const chain = await store.listRange('ledger');
  chain.splice(1, 1); // remove the middle entry -> breaks e2.prevHash linkage
  const res = ledger.verifyChain(chain);
  assert.strictEqual(res.valid, false);
  assert.strictEqual(res.brokenAt, 1);
});

// ---- #7 operator rep assignment ---------------------------------------------

test('setAssignedRep: operator assigns a valid rep, rejects unknown, can clear', async () => {
  process.env.REP_CREDENTIALS = 'marcus:x,alice:y';
  try {
    const lead = await leads.createLead({ name: 'Katy Roof', phone: '5551230000' }, { source: 'web' });
    const a = await leads.setAssignedRep(lead.id, 'marcus', { actor: 'operator' });
    assert.strictEqual(a.assignedRep, 'marcus');
    assert.ok(a.assignedAt, 'first assignment stamps the SLA clock');

    await assert.rejects(() => leads.setAssignedRep(lead.id, 'ghost'), /unknown rep/i);

    const cleared = await leads.setAssignedRep(lead.id, '', { actor: 'operator' });
    assert.strictEqual(cleared.assignedRep, null);
  } finally {
    delete process.env.REP_CREDENTIALS;
  }
});

// ---- #10 rep-token forgery rejection (with a real signing key) ---------------

test('verifyRepToken: tampered payload / bad signature / no-dot all rejected', () => {
  process.env.SESSION_SECRET = 'test-session-secret-abcdefghijklmnop';
  try {
    const token = auth.issueRepToken('alice');
    assert.strictEqual(auth.verifyRepToken(token).rep, 'alice', 'valid token verifies');

    const dot = token.lastIndexOf('.');
    const payload = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    // (a) rewrite rep -> admin WITHOUT re-signing.
    const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    obj.rep = 'admin';
    const forged = Buffer.from(JSON.stringify(obj)).toString('base64url') + '.' + sig;
    assert.strictEqual(auth.verifyRepToken(forged), null, 'forged payload rejected');

    // (b) flip one signature char.
    const badSig = sig.slice(0, -1) + (sig.slice(-1) === 'a' ? 'b' : 'a');
    assert.strictEqual(auth.verifyRepToken(payload + '.' + badSig), null, 'bad signature rejected');

    // (c) no dot.
    assert.strictEqual(auth.verifyRepToken('nodothere'), null);
  } finally {
    delete process.env.SESSION_SECRET;
  }
});

// ---- #19 DNC no-provider fail-safe throw ------------------------------------

test('recordScrub: throws (fail-safe) when no DNC provider is configured', async () => {
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
  const lead = await leads.createLead({ name: 'Cold', phone: '5559990000' }, { source: 'storm' });
  await assert.rejects(
    () => dnc.recordScrub(lead, { provider: 'x', result: 'clear', actor: 'op' }),
    /provider/i
  );
  assert.ok(!lead.dncScrub, 'no fabricated scrub recorded');
  assert.strictEqual(dnc.isCallable(lead).callable, false);
});

// ---- #4 login rate limiter ---------------------------------------------------

test('ratelimit: blocks after max hits in the window, clears on demand', async () => {
  const key = 'rl:test:1';
  for (let i = 0; i < 5; i += 1) await rl.hit(key, { max: 5, windowMs: 10000 });
  assert.strictEqual(await rl.isBlocked(key, { max: 5 }), true, 'blocked at the cap');
  const sixth = await rl.hit(key, { max: 5, windowMs: 10000 });
  assert.strictEqual(sixth.blocked, true);
  await rl.clear(key);
  assert.strictEqual(await rl.isBlocked(key, { max: 5 }), false, 'cleared');
});

test('ratelimit: clientIp prefers trusted headers over spoofable x-forwarded-for', () => {
  assert.strictEqual(
    rl.clientIp({ headers: { 'x-forwarded-for': '1.2.3.4', 'x-vercel-forwarded-for': '9.9.9.9' } }),
    '9.9.9.9'
  );
  assert.strictEqual(rl.clientIp({ headers: {} }), 'unknown');
});
