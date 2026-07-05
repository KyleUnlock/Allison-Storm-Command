'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const leads = require('../lib/leads');
const ledger = require('../lib/ledger');

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => store._resetMemory());

test('COMMISSION_RATE is exactly 0.20 (20% of profit, never 30%)', () => {
  assert.strictEqual(leads.COMMISSION_RATE, 0.2);
});

test('canonical billing: $9,000 collected - $5,000 costs -> $4,000 profit -> $800 fee', async () => {
  const lead = await leads.createLead({ name: 'Jo', phone: '5551234567' }, { source: 'web' });
  const won = await leads.updateStatus(lead.id, 'won', { collected: 9000, costs: 5000 });
  assert.strictEqual(won.won.profit, 4000);
  assert.strictEqual(won.won.fee, 800);
  assert.strictEqual(won.won.reason, 'billable');
});

test('fee is on PROFIT not revenue (0 costs -> 20% of collected)', async () => {
  const lead = await leads.createLead({ name: 'A' }, { source: 'web' });
  const won = await leads.updateStatus(lead.id, 'won', { collected: 1000, costs: 0 });
  assert.strictEqual(won.won.fee, 200);
});

test('known customer bills $0', async () => {
  const lead = await leads.createLead({ name: 'Repeat' }, { source: 'web', knownCustomer: true });
  const won = await leads.updateStatus(lead.id, 'won', { collected: 9000, costs: 5000 });
  assert.strictEqual(won.won.fee, 0);
  assert.strictEqual(won.won.reason, 'known-customer');
});

test('strict attribution: a Won without server-stamped attribution bills $0', () => {
  const orphan = { deliveredAt: new Date().toISOString(), knownCustomer: false };
  const b = leads.computeBilling(orphan, {
    collected: 9000, costs: 5000, contractDate: Date.now(), serverNow: Date.now(),
  });
  assert.strictEqual(b.fee, 0);
  assert.strictEqual(b.reason, 'no-attribution');
});

test('90-day window clamped on BOTH ends: future contractDate is clamped to serverNow and still bills', async () => {
  const lead = await leads.createLead({ name: 'Future' }, { source: 'web' });
  const future = new Date(Date.now() + 400 * DAY).toISOString();
  const won = await leads.updateStatus(lead.id, 'won', { collected: 9000, costs: 5000, contractDate: future });
  assert.strictEqual(won.won.fee, 800, 'future date must not dodge the fee');
  assert.strictEqual(won.won.clamped, true);
  // clamped sign date must be <= now, not the far-future value
  assert.ok(Date.parse(won.won.contractDate) <= Date.now() + 1000);
});

test('90-day window: a Won signed outside the window bills $0', async () => {
  const lead = await leads.createLead({ name: 'Stale' }, { source: 'web' });
  // Backdate delivery to 120 days ago so "now" is past the 90-day window end.
  const stored = await leads.getLead(lead.id);
  stored.deliveredAt = new Date(Date.now() - 120 * DAY).toISOString();
  await leads.saveLead(stored);
  const won = await leads.updateStatus(lead.id, 'won', { collected: 9000, costs: 5000 });
  assert.strictEqual(won.won.fee, 0);
  assert.strictEqual(won.won.reason, 'outside-90d-window');
});

test('90-day clamp lower bound: a contractDate before deliveredAt is clamped up, still bills', async () => {
  const lead = await leads.createLead({ name: 'Early' }, { source: 'web' });
  const past = new Date(Date.now() - 500 * DAY).toISOString();
  const won = await leads.updateStatus(lead.id, 'won', { collected: 9000, costs: 5000, contractDate: past });
  assert.strictEqual(won.won.fee, 800);
  assert.ok(Date.parse(won.won.contractDate) >= Date.parse(won.deliveredAt));
});

test('hash-chained ledger: a broken chain is detectable', async () => {
  await ledger.append({ type: 'test.a', data: { n: 1 } });
  await ledger.append({ type: 'test.b', data: { n: 2 } });
  await ledger.append({ type: 'test.c', data: { n: 3 } });

  const good = await ledger.verify();
  assert.strictEqual(good.valid, true);

  // Tamper with a stored entry's payload, leaving its hash unchanged.
  const chain = await store.listRange('ledger');
  chain[1].payload.data.n = 999;
  const bad = ledger.verifyChain(chain);
  assert.strictEqual(bad.valid, false);
  assert.strictEqual(bad.brokenAt, 1);
});
