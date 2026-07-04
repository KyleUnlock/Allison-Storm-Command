'use strict';

process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const leads = require('../lib/leads');
const server = require('../serve.local');

let base;
const BOARD = { 'X-Board-Password': 'AllisonStorm-Cmd-2026', 'Content-Type': 'application/json' };

before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());

async function patch(body) {
  return fetch(`${base}/api/board`, { method: 'PATCH', headers: BOARD, body: JSON.stringify(body) });
}

test('CRM kanban has exactly 9 stage columns', () => {
  assert.strictEqual(leads.STAGES.length, 9);
});

test('stage moves go through the shared /api/board PATCH path', async () => {
  const a = await leads.createLead({ name: 'A' }, { source: 'web' });
  const r1 = await patch({ id: a.id, status: 'contacted' });
  assert.strictEqual(r1.status, 200);
  const r2 = await patch({ id: a.id, status: 'inspection' });
  assert.strictEqual(r2.status, 200);
  const board = await (await fetch(`${base}/api/board`, { headers: BOARD })).json();
  assert.strictEqual(board.leads.find((l) => l.id === a.id).status, 'inspection');
});

test('invalid stage is rejected by the shared PATCH path (400)', async () => {
  const a = await leads.createLead({ name: 'A' }, { source: 'web' });
  const r = await patch({ id: a.id, status: 'not-a-real-stage' });
  assert.strictEqual(r.status, 400);
});

test('Won-column dollar total sums collected of Won leads', async () => {
  const a = await leads.createLead({ name: 'A' }, { source: 'web' });
  const b = await leads.createLead({ name: 'B' }, { source: 'web' });
  const c = await leads.createLead({ name: 'C' }, { source: 'web' });
  await patch({ id: a.id, status: 'won', collected: 9000, costs: 5000 });
  await patch({ id: b.id, status: 'won', collected: 12000, costs: 4000 });
  await patch({ id: c.id, status: 'contacted' }); // not won

  const board = await (await fetch(`${base}/api/board`, { headers: BOARD })).json();
  assert.strictEqual(board.wonTotal, 21000);
  // fee total = 20% of (4000 + 8000) = 800 + 1600 = 2400
  assert.strictEqual(board.feeTotal, 2400);
});
