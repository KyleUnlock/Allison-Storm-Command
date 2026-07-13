'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const store = require('../lib/store');
const storm = require('../lib/storm');
const dnc = require('../lib/dnc');
const leads = require('../lib/leads');

beforeEach(() => store._resetMemory());

test('storm copy uses approved NWS phrasing, never a per-home strike claim', () => {
  const h = storm.compliantHeadline('77002');
  assert.match(h, /hail reported near 77002 per NWS/i);
  assert.doesNotMatch(h, /your roof was hit/i);
  assert.doesNotMatch(storm.compliantBlurb('77002'), /your roof was hit/i);
});

test('NWS hail lookup is fail-safe: unknown/invalid ZIP -> not reported', () => {
  assert.strictEqual(storm.hailReport('00000').reported, false);
  assert.strictEqual(storm.hailReport('abc').reported, false);
  assert.strictEqual(storm.hailReport('77002').reported, true);
});

test('DNC fail-safe: an unscrubbed COLD lead with no provider is NOT callable (correct withhold)', () => {
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
  const cold = { id: 'x', phone: '5551234567', source: 'storm', consent: false, dnc: false };
  const res = dnc.isCallable(cold);
  assert.strictEqual(res.callable, false);
  assert.strictEqual(res.reason, 'withheld-no-provider');
});

test('DNC: a cold lead becomes callable only after a provider scrub WITH provenance', async () => {
  process.env.DNC_PROVIDER = 'test-provider';
  process.env.DNC_API_KEY = 'test-key';
  const lead = await leads.createLead({ name: 'Cold', phone: '5551234567' }, { source: 'storm' });
  assert.strictEqual(dnc.isCallable(lead).callable, false, 'withheld before scrub');

  await dnc.recordScrub(lead, { provider: 'test-provider', result: 'clear', actor: 'system' });
  assert.strictEqual(dnc.isCallable(lead).callable, true, 'callable after clear scrub with provenance');

  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
});

test('DNC one-directional: a DNC hit hard-flags the lead and stays not-callable', async () => {
  process.env.DNC_PROVIDER = 'test-provider';
  process.env.DNC_API_KEY = 'test-key';
  const lead = await leads.createLead({ name: 'OptOut', phone: '5559998888' }, { source: 'ad' });
  await dnc.recordScrub(lead, { provider: 'test-provider', result: 'dnc', actor: 'system' });
  assert.strictEqual(lead.dnc, true);
  assert.strictEqual(dnc.isCallable(lead).callable, false);
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
});

test('warm inbound web lead with express consent is callable without an external scrub', () => {
  const warm = { id: 'w', phone: '5551112222', source: 'web', consent: true, dnc: false };
  assert.strictEqual(dnc.isCallable(warm).callable, true);
});

test('lint:copy passes on the shipped surfaces', () => {
  const root = path.resolve(__dirname, '..');
  // throws (non-zero exit) if banned copy is present
  const out = execFileSync('node', ['scripts/lint-copy.js'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /lint:copy OK/);
});
