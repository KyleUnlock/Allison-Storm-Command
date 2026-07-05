'use strict';

// Env must be set before requiring the handlers/server.
process.env.REP_CREDENTIALS = 'alice:secret123,bob:passcodeB';
process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const server = require('../serve.local');

let base;

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());

const BOARD = { 'X-Board-Password': 'AllisonStorm-Cmd-2026' };

function repCookie(setCookie) {
  const m = /alr_rep=([^;]+)/.exec(setCookie || '');
  return m ? `alr_rep=${m[1]}` : '';
}

async function postLead(body) {
  return fetch(`${base}/api/leads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

test('public POST rejects gated source "storm"', async () => {
  const r = await postLead({ source: 'storm', phone: '5550001111' });
  assert.strictEqual(r.status, 400);
});

test('public POST accepts source web/ad/rep', async () => {
  for (const source of ['web', 'ad', 'rep']) {
    const r = await postLead({ source, phone: '5550002222' });
    assert.strictEqual(r.status, 201, `source ${source}`);
  }
});

test('public POST sanitizes strings and forces knownCustomer=false, ignores self-attested flags', async () => {
  const r = await postLead({
    source: 'web',
    name: '<script>alert(1)</script>Bob',
    phone: '(555) 123-4567',
    notes: 'javascript:evil() <img onerror=x>',
    knownCustomer: true, // must be ignored/forced false
    dnc: false,          // self-attested — must be ignored
    consent: true,       // self-attested — public path never trusts it
  });
  assert.strictEqual(r.status, 201);
  const { id } = await r.json();

  const board = await (await fetch(`${base}/api/board`, { headers: BOARD })).json();
  const lead = board.leads.find((l) => l.id === id);
  assert.ok(lead, 'lead present on board');
  assert.strictEqual(lead.knownCustomer, false);
  assert.ok(!/[<>]/.test(lead.name), 'name has no angle brackets');
  assert.ok(!/script/i.test(lead.name), 'script token stripped');
  assert.strictEqual(lead.phone, '5551234567', 'phone digit-normalized');
});

test('rep login: wrong passcode -> 401', async () => {
  const r = await fetch(`${base}/api/rep-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', passcode: 'WRONG' }),
  });
  assert.strictEqual(r.status, 401);
});

test('rep login: correct passcode -> 200 and /api/my-leads -> 200 with cookie', async () => {
  const login = await fetch(`${base}/api/rep-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', passcode: 'secret123' }),
  });
  assert.strictEqual(login.status, 200);
  const cookie = repCookie(login.headers.get('set-cookie'));
  assert.ok(cookie, 'issued alr_rep cookie');

  const mine = await fetch(`${base}/api/my-leads`, { headers: { Cookie: cookie } });
  assert.strictEqual(mine.status, 200);
});

test('rep does NOT authenticate via BOARD_PASSWORD', async () => {
  const r = await fetch(`${base}/api/rep-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', passcode: 'AllisonStorm-Cmd-2026' }),
  });
  assert.strictEqual(r.status, 401);
});

test('/api/my-leads without a session -> 401', async () => {
  const r = await fetch(`${base}/api/my-leads`);
  assert.strictEqual(r.status, 401);
});

test('a rep session 401s on the operator /api/board', async () => {
  const login = await fetch(`${base}/api/rep-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', passcode: 'secret123' }),
  });
  const cookie = repCookie(login.headers.get('set-cookie'));
  const board = await fetch(`${base}/api/board`, { headers: { Cookie: cookie } });
  assert.strictEqual(board.status, 401);
});

test('operator /api/board gating: no password -> 401, correct -> 200', async () => {
  const no = await fetch(`${base}/api/board`);
  assert.strictEqual(no.status, 401);
  const yes = await fetch(`${base}/api/board`, { headers: BOARD });
  assert.strictEqual(yes.status, 200);
});

test('rep PATCH is scoped to own leads; another rep gets 403', async () => {
  // create a lead and assign it to bob directly
  const leads = require('../lib/leads');
  const lead = await leads.createLead({ name: 'BobsLead' }, { source: 'web', assignedRep: 'bob' });

  const login = await fetch(`${base}/api/rep-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'alice', passcode: 'secret123' }),
  });
  const cookie = repCookie(login.headers.get('set-cookie'));
  const patch = await fetch(`${base}/api/my-leads`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ id: lead.id, status: 'contacted' }),
  });
  assert.strictEqual(patch.status, 403);
});
