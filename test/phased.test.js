'use strict';

/**
 * test/phased.test.js — Phase D: paid-play ad-source webhooks (SHIP DARK).
 *
 * Both webhooks map external ad leads into the EXISTING sanitized createLead
 * path with source='ad'. They are signature-verified and FAIL CLOSED when their
 * env secret is unset: a live probe returns the designed 401/403 — never 500,
 * never a lead. When configured + validly signed, a sanitized source='ad' lead
 * IS created and inherits scoring + DNC gating.
 */

process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const store = require('../lib/store');
const leads = require('../lib/leads');
const dnc = require('../lib/dnc');
const server = require('../serve.local');

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());
afterEach(() => {
  delete process.env.META_APP_SECRET;
  delete process.env.META_VERIFY_TOKEN;
  delete process.env.CALLRAIL_SIGNING_KEY;
  delete process.env.DNC_PROVIDER;
  delete process.env.DNC_API_KEY;
});

const metaSig = (raw, secret) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
const callrailSig = (raw, secret) =>
  crypto.createHmac('sha256', secret).update(raw).digest('base64');

const META_BODY = JSON.stringify({
  entry: [
    {
      changes: [
        {
          field: 'leadgen',
          value: {
            campaign_id: 'cmp_9',
            ad_id: 'ad_7',
            form_id: 'form_3',
            leadgen_id: 'lg_1',
            platform: 'fb',
            field_data: [
              { name: 'full_name', values: ['Jordan Homeowner'] },
              { name: 'phone_number', values: ['(555) 314-1592'] },
              { name: 'email', values: ['jordan@example.com'] },
              { name: 'zip_code', values: ['75002'] },
            ],
          },
        },
      ],
    },
  ],
});

const CALLRAIL_BODY = JSON.stringify({
  id: 'CAL123',
  customer_name: 'Pat Caller',
  customer_phone_number: '+1 (555) 867-5309',
  customer_zip: '75070',
  campaign: 'Spring Storm',
  source: 'Google LSA',
  gclid: 'gclid_abc',
  duration: '92',
});

// ---------------------------------------------------------------------------
// D — Meta Instant Form webhook
// ---------------------------------------------------------------------------

test('D/meta (a): unset META_APP_SECRET fails closed 401, creates NO lead', async () => {
  const r = await fetch(`${base}/api/meta-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': metaSig(META_BODY, 'x') },
    body: META_BODY,
  });
  assert.strictEqual(r.status, 401, 'designed fail-closed status, not 500');
  assert.notStrictEqual(r.status, 500);
  assert.strictEqual((await leads.listLeads()).length, 0, 'no lead created');
});

test('D/meta (b): bad signature fails closed 401, creates NO lead', async () => {
  process.env.META_APP_SECRET = 'meta-secret';
  const r = await fetch(`${base}/api/meta-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=deadbeef' },
    body: META_BODY,
  });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await leads.listLeads()).length, 0);
});

test('D/meta (c): valid signature creates a sanitized source=ad lead that scores + is DNC-gated', async () => {
  process.env.META_APP_SECRET = 'meta-secret';
  const r = await fetch(`${base}/api/meta-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': metaSig(META_BODY, 'meta-secret'),
    },
    body: META_BODY,
  });
  assert.strictEqual(r.status, 200);
  const { id } = await r.json();
  const lead = await leads.getLead(id);

  assert.strictEqual(lead.source, 'ad');
  assert.strictEqual(lead.adSource, 'meta');
  assert.strictEqual(lead.knownCustomer, false, 'knownCustomer forced false');
  assert.strictEqual(lead.consent, false, 'no self-attested consent from payload');
  assert.strictEqual(typeof lead.score, 'number', 'flows through createLead scoring');
  assert.strictEqual(lead.name, 'Jordan Homeowner');
  assert.strictEqual(lead.phone, '5553141592', 'phone sanitized to digits');
  assert.strictEqual(lead.campaign.campaignId, 'cmp_9', 'campaign tagged for analytics');

  // Cold ad lead: NOT callable until DNC-scrubbed (no provider configured).
  const call = dnc.isCallable(lead);
  assert.strictEqual(call.callable, false, 'cold ad lead withheld from calling');
  assert.strictEqual(call.reason, 'withheld-no-provider');
});

test('D/meta (d): GET verify handshake echoes challenge ONLY with the correct token', async () => {
  // token env unset -> fail closed 403 (no echo)
  let r = await fetch(
    `${base}/api/meta-webhook?hub.mode=subscribe&hub.verify_token=whatever&hub.challenge=CH1`
  );
  assert.strictEqual(r.status, 403, 'unset verify token fails closed');

  process.env.META_VERIFY_TOKEN = 'verify-me';
  // wrong token -> 403, no echo
  r = await fetch(
    `${base}/api/meta-webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=CH1`
  );
  assert.strictEqual(r.status, 403);

  // correct token -> echo challenge verbatim
  r = await fetch(
    `${base}/api/meta-webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=CH1`
  );
  assert.strictEqual(r.status, 200);
  assert.strictEqual(await r.text(), 'CH1');
});

// ---------------------------------------------------------------------------
// D — Google LSA / CallRail webhook
// ---------------------------------------------------------------------------

test('D/callrail (a): unset CALLRAIL_SIGNING_KEY fails closed 401, creates NO lead', async () => {
  const r = await fetch(`${base}/api/callrail-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CallRail-Signature': callrailSig(CALLRAIL_BODY, 'x') },
    body: CALLRAIL_BODY,
  });
  assert.strictEqual(r.status, 401, 'designed fail-closed status, not 500');
  assert.notStrictEqual(r.status, 500);
  assert.strictEqual((await leads.listLeads()).length, 0);
});

test('D/callrail (b): bad signature fails closed 401, creates NO lead', async () => {
  process.env.CALLRAIL_SIGNING_KEY = 'cr-key';
  const r = await fetch(`${base}/api/callrail-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CallRail-Signature': 'bm90LXZhbGlk' },
    body: CALLRAIL_BODY,
  });
  assert.strictEqual(r.status, 401);
  assert.strictEqual((await leads.listLeads()).length, 0);
});

test('D/callrail (c): valid signature creates a source=ad lead (adSource=lsa) that scores + is DNC-gated', async () => {
  process.env.CALLRAIL_SIGNING_KEY = 'cr-key';
  const r = await fetch(`${base}/api/callrail-webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CallRail-Signature': callrailSig(CALLRAIL_BODY, 'cr-key'),
    },
    body: CALLRAIL_BODY,
  });
  assert.strictEqual(r.status, 200);
  const { id } = await r.json();
  const lead = await leads.getLead(id);

  assert.strictEqual(lead.source, 'ad');
  assert.strictEqual(lead.adSource, 'lsa', 'Google LSA origin tagged as lsa');
  assert.strictEqual(lead.knownCustomer, false);
  assert.strictEqual(lead.consent, false);
  assert.strictEqual(typeof lead.score, 'number');
  assert.strictEqual(lead.phone, '15558675309', 'caller number captured (sanitized)');
  assert.strictEqual(lead.campaign.gclid, 'gclid_abc', 'click id tagged for analytics');

  // Caller number is a cold 'ad' phone: NOT callable until DNC-scrubbed.
  const call = dnc.isCallable(lead);
  assert.strictEqual(call.callable, false, 'ad caller number not callable until scrubbed');
  assert.strictEqual(call.reason, 'withheld-no-provider');
});
