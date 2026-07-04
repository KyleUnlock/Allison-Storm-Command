'use strict';

// Env for the server-backed endpoint tests (export gate).
process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const fs = require('fs');
const path = require('path');
const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const leads = require('../lib/leads');
const ledger = require('../lib/ledger');
const dnc = require('../lib/dnc');
const exporter = require('../lib/export');
const consent = require('../lib/consent');
const notices = require('../lib/notices');
const server = require('../serve.local');

const ROOT = path.resolve(__dirname, '..');
const BOARD = { 'X-Board-Password': 'AllisonStorm-Cmd-2026', 'Content-Type': 'application/json' };

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());
afterEach(() => {
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
});

function withProvider() {
  process.env.DNC_PROVIDER = 'AcmeDNC';
  process.env.DNC_API_KEY = 'test-key';
}

// ---------------------------------------------------------------------------
// B1 — DNC gate on the export path
// ---------------------------------------------------------------------------

test('B1: an UNSCRUBBED cold lead phone is redacted/absent in the export CSV', async () => {
  withProvider(); // provider IS configured, but this lead was never scrubbed
  const cold = await leads.createLead({ name: 'Cold', phone: '5559990001' }, { source: 'storm' });
  const csv = exporter.toCsv([cold]);
  assert.ok(!csv.includes('5559990001'), 'unscrubbed cold phone must not appear');
  assert.ok(csv.includes(exporter.REDACTED), 'redaction marker present');
});

test('B1: a PROPERLY-SCRUBBED cold lead phone IS present in the export CSV', async () => {
  withProvider();
  const cold = await leads.createLead({ name: 'Scrubbed', phone: '5559990002' }, { source: 'storm' });
  await dnc.recordScrub(cold, { provider: 'AcmeDNC', result: 'clear', actor: 'op' });
  await leads.saveLead(cold);
  const csv = exporter.toCsv([cold]);
  assert.ok(csv.includes('5559990002'), 'scrubbed-clear phone must be present');
});

// THE B1 FAIL-SAFE: no provider configured -> every cold phone withheld.
test('B1 FAIL-SAFE: with NO DNC provider env set, ALL cold phones are withheld', async () => {
  // provider intentionally unset (afterEach clears it; nothing sets it here)
  const a = await leads.createLead({ name: 'A', phone: '5551110001' }, { source: 'storm' });
  const b = await leads.createLead({ name: 'B', phone: '5551110002' }, { source: 'ad' });
  const csv = exporter.toCsv([a, b]);
  assert.ok(!csv.includes('5551110001'), 'storm cold phone withheld');
  assert.ok(!csv.includes('5551110002'), 'ad cold phone withheld');
  assert.strictEqual(exporter.exportPhone(a), exporter.REDACTED);
  assert.strictEqual(exporter.exportPhone(b), exporter.REDACTED);
});

test('B1: export endpoint is operator-gated and withholds an unscrubbed cold phone', async () => {
  // no provider -> cold lead withheld end-to-end through the endpoint
  await leads.createLead({ name: 'ColdEnd', phone: '5552220003' }, { source: 'storm' });

  const noauth = await fetch(`${base}/api/export`);
  assert.strictEqual(noauth.status, 401, 'no operator password -> 401');

  const r = await fetch(`${base}/api/export`, { headers: BOARD });
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/csv/);
  const csv = await r.text();
  assert.ok(!csv.includes('5552220003'), 'endpoint must not leak the cold phone');
});

// ---------------------------------------------------------------------------
// B2 — TX SB140 SMS consent + opt-out
// ---------------------------------------------------------------------------

// THE B2 FAIL-SAFE: absence of consent means NOT SMS-callable.
test('B2 FAIL-SAFE: a number with NO consent record is NOT SMS-callable', async () => {
  const state = await consent.isSmsCallable('5553330001');
  assert.strictEqual(state.callable, false);
  assert.strictEqual(state.reason, 'no-consent');
});

test('B2: express consent makes a number SMS-callable', async () => {
  await consent.recordConsent('5553330002', { source: 'web-intake', leadId: 'ld_x' });
  const state = await consent.isSmsCallable('5553330002');
  assert.strictEqual(state.callable, true);
  assert.strictEqual(state.reason, 'sms-consent');
});

test('B2: STOP opts the contact out and is ledgered', async () => {
  const r = await fetch(`${base}/api/sms-optout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: '5553330003', message: 'STOP' }),
  });
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.strictEqual(body.optedOut, true);
  assert.strictEqual(body.smsCallable, false);

  const state = await consent.isSmsCallable('5553330003');
  assert.strictEqual(state.callable, false);
  assert.strictEqual(state.reason, 'sms-opted-out');

  const chain = await ledger.all();
  assert.ok(
    chain.some((e) => e.payload.type === 'sms.optout' && e.payload.data.phone === '5553330003'),
    'opt-out is recorded in the ledger'
  );
});

test('B2: opted-out STAYS opted-out — a later consent write cannot re-open it', async () => {
  await consent.recordConsent('5553330004', { source: 'web-intake' }); // consented first
  assert.strictEqual((await consent.isSmsCallable('5553330004')).callable, true);

  await consent.recordOptOut('5553330004', { actor: 'consumer', via: 'sms', message: 'STOP' });
  assert.strictEqual((await consent.isSmsCallable('5553330004')).callable, false);

  // Attempt to silently re-open with a fresh consent record — must NOT work.
  await consent.recordConsent('5553330004', { source: 'web-intake' });
  const after = await consent.isSmsCallable('5553330004');
  assert.strictEqual(after.callable, false, 'opt-out is one-directional');
  assert.strictEqual(after.reason, 'sms-opted-out');
});

test('B2: public intake stays sanitized — SMS consent capture does not make a cold lead voice-callable', async () => {
  // A web lead with smsConsent captures SMS consent but voice-DNC is untouched.
  const r = await fetch(`${base}/api/leads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'web', phone: '5554440001', smsConsent: true }),
  });
  assert.strictEqual(r.status, 201);
  const body = await r.json();
  assert.strictEqual(body.smsConsent, true);
  // SMS consent recorded...
  assert.strictEqual((await consent.isSmsCallable('5554440001')).callable, true);
  // ...but the STOP handler still one-directionally overrides it.
});

// ---------------------------------------------------------------------------
// B3 — 3-day right-to-cancel notice + presence lint
// ---------------------------------------------------------------------------

test('B3: lib/notices exports the canonical 3-day cancel notice, accurately worded', () => {
  assert.match(notices.NOTICE_3DAY_CANCEL, /third business day/);
  assert.match(notices.NOTICE_3DAY_CANCEL, /cancel this transaction/i);
  // no overclaims / no banned deductible language
  assert.doesNotMatch(notices.NOTICE_3DAY_CANCEL, /deductible/i);
});

// THE B3 FAIL-SAFE: the presence lint fails if a required notice is missing.
test('B3 FAIL-SAFE: required compliance copy is present on its page (lint presence check)', () => {
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const noticeHtml = fs.readFileSync(path.join(ROOT, 'notice.html'), 'utf8');

  // Live pages carry the required markers...
  assert.ok(indexHtml.includes(consent.SMS_CONSENT_MARKER), 'intake carries SB140 consent copy');
  assert.ok(noticeHtml.includes(notices.NOTICE_3DAY_CANCEL_MARKER), 'notice carries 3-day cancel copy');

  // ...and a page that DROPPED the notice would be flagged by the same check.
  const stripped = noticeHtml.split(notices.NOTICE_3DAY_CANCEL_MARKER).join('X');
  assert.ok(!stripped.includes(notices.NOTICE_3DAY_CANCEL_MARKER), 'missing marker is detectable');
});
