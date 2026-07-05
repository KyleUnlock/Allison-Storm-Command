'use strict';

/**
 * test/phasef.test.js — Phase F: analytics & reporting (READ-ONLY).
 *
 * Fences under test:
 *  - the report is pure aggregation over KV (leads + ledger) — no mutation, and
 *    the UnlockAI fee is the locked 20% of PROFIT (collected − direct costs),
 *    never a cut of revenue: a $9k−$5k won lead rolls up to an $800 fee.
 *  - /api/report is board-password gated: 401 without it, 200 JSON with it.
 *  - every rate guards divide-by-zero: an empty store returns zeros, not NaN.
 *  - the ledger-integrity badge reflects ledger.verifyChain().
 */

process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');

const store = require('../lib/store');
const leads = require('../lib/leads');
const analytics = require('../lib/analytics');
const server = require('../serve.local');

const BOARD = { 'X-Board-Password': 'AllisonStorm-Cmd-2026', 'Content-Type': 'application/json' };
const MIN = 60 * 1000;

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => store._resetMemory());

// Seed one lead through the REAL lifecycle path so it carries server-stamped
// attribution + a genuine computeBilling won record. SLA anchors are patched
// directly (checkSla reads them); won math is never faked.
async function seed({
  source = 'web',
  adSource = null,
  campaign = null,
  rep = null,
  stage = null,
  collected = null,
  costs = null,
  assignedAt = null,
  firstTouchAt = null,
} = {}) {
  const lead = await leads.createLead(
    { name: 'Test Homeowner', phone: '5550001111', zip: '75001' },
    { source, adSource, campaign, assignedRep: rep }
  );
  const fresh = await leads.getLead(lead.id);
  if (assignedAt) fresh.assignedAt = assignedAt;
  if (firstTouchAt) fresh.firstTouchAt = firstTouchAt;
  await leads.saveLead(fresh);
  if (collected != null) {
    await leads.updateStatus(lead.id, 'won', { collected, costs, actor: 'operator' });
  } else if (stage) {
    await leads.updateStatus(lead.id, stage, { actor: 'operator' });
  }
  return leads.getLead(lead.id);
}

const findStage = (report, name) => report.funnel.stages.find((s) => s.stage === name);

// ===========================================================================
// Funnel counts + conversion math
// ===========================================================================

test('F/funnel: stage counts, cumulative reach, and lead→won conversion', async () => {
  await seed({}); // new
  await seed({}); // new
  await seed({ stage: 'contacted' }); // contacted
  await seed({ collected: 9000, costs: 5000 }); // won
  await seed({ collected: 1000, costs: 500 }); // won

  const report = await analytics.buildReport();
  assert.strictEqual(report.totals.leads, 5);
  assert.strictEqual(findStage(report, 'new').count, 2);
  assert.strictEqual(findStage(report, 'contacted').count, 1);
  assert.strictEqual(findStage(report, 'won').count, 2);

  // Cumulative reach: everyone has reached 'new'; 3 are at-or-beyond 'contacted'.
  assert.strictEqual(findStage(report, 'new').reached, 5);
  assert.strictEqual(findStage(report, 'contacted').reached, 3);
  assert.strictEqual(findStage(report, 'contacted').conversionFromPrev, 0.6); // 3/5

  // Overall lead→won: 2 of 5.
  assert.strictEqual(report.totals.won, 2);
  assert.strictEqual(report.funnel.overallWonRate, 0.4);
  assert.strictEqual(report.totals.wonRate, 0.4);
});

// ===========================================================================
// Source ROI grouping + the locked 20%-of-profit fee
// ===========================================================================

test('F/roi fee=20%-of-profit rollup: $9k−$5k won lead ⇒ $800 fee across groups', async () => {
  await seed({ source: 'web', collected: 9000, costs: 5000 }); // profit 4000 → fee 800
  await seed({
    source: 'ad',
    adSource: 'meta',
    campaign: { campaign: 'Spring Storm' },
    collected: 20000,
    costs: 12000,
  }); // profit 8000 → fee 1600
  await seed({ source: 'web' }); // unworked web lead, no won

  const report = await analytics.buildReport();

  const web = report.sourceRoi.bySource.find((g) => g.key === 'web');
  const ad = report.sourceRoi.bySource.find((g) => g.key === 'ad');
  assert.strictEqual(web.leads, 2);
  assert.strictEqual(web.won, 1);
  assert.strictEqual(web.profit, 4000);
  assert.strictEqual(web.fee, 800, 'fee is exactly 20% of the $4k profit');
  assert.strictEqual(web.fee, Math.round(web.profit * 0.2), 'fee === 20% × profit');
  assert.strictEqual(ad.fee, 1600);

  // adSource + campaign groupings surface the paid-play fee too.
  const meta = report.sourceRoi.byAdSource.find((g) => g.key === 'meta');
  const camp = report.sourceRoi.byCampaign.find((g) => g.key === 'Spring Storm');
  assert.strictEqual(meta.fee, 1600);
  assert.strictEqual(camp.fee, 1600);

  // UnlockAI fee roll-up = sum of 20%-of-profit across won leads.
  assert.strictEqual(report.fee.total, 2400);
  assert.strictEqual(report.fee.commissionRate, 0.2);
  assert.strictEqual(report.fee.term, '20% of profit');
  assert.strictEqual(report.totals.wonProfit, 12000);
});

// ===========================================================================
// SLA breach rate + latency
// ===========================================================================

test('F/sla: first-touch breach rate and latency stats', async () => {
  const now = Date.now();
  // Breached: assigned 120 min ago, never touched (threshold 60).
  await seed({ assignedAt: new Date(now - 120 * MIN).toISOString() });
  // On-time: assigned 30 min ago, touched 5 min later.
  await seed({
    assignedAt: new Date(now - 30 * MIN).toISOString(),
    firstTouchAt: new Date(now - 25 * MIN).toISOString(),
  });
  // Unassigned: never counts as breached.
  await seed({});

  const report = await analytics.buildReport({ now });
  assert.strictEqual(report.sla.total, 3);
  assert.strictEqual(report.sla.breached, 1);
  assert.strictEqual(report.sla.breachRate, analytics.rate(1, 3)); // 0.3333
  assert.strictEqual(report.sla.touchedCount, 1);
  assert.strictEqual(report.sla.medianMinutes, 5);
  assert.strictEqual(report.sla.avgMinutes, 5);
});

// ===========================================================================
// Rep leaderboard aggregation
// ===========================================================================

test('F/leaderboard: per-rep assigned / worked / won / fee', async () => {
  const now = Date.now();
  await seed({ rep: 'Alex', firstTouchAt: new Date(now).toISOString(), collected: 9000, costs: 5000 }); // won, worked
  await seed({ rep: 'Alex' }); // assigned only
  await seed({ rep: 'Sam' }); // assigned only

  const report = await analytics.buildReport();
  const alex = report.leaderboard.find((g) => g.rep === 'Alex');
  const sam = report.leaderboard.find((g) => g.rep === 'Sam');

  assert.strictEqual(alex.assigned, 2);
  assert.strictEqual(alex.worked, 1);
  assert.strictEqual(alex.won, 1);
  assert.strictEqual(alex.fee, 800);
  assert.strictEqual(sam.assigned, 1);
  assert.strictEqual(sam.worked, 0);
  assert.strictEqual(sam.won, 0);
  assert.strictEqual(sam.fee, 0);
});

// ===========================================================================
// Empty store — zeros, never NaN
// ===========================================================================

test('F/empty: empty store returns zeros not NaN', async () => {
  const report = await analytics.buildReport();
  const numbers = [
    report.totals.leads,
    report.totals.won,
    report.totals.wonRate,
    report.totals.wonCollected,
    report.totals.wonProfit,
    report.funnel.overallWonRate,
    report.sla.breachRate,
    report.sla.medianMinutes,
    report.sla.avgMinutes,
    report.fee.total,
    findStage(report, 'contacted').conversionFromPrev,
  ];
  for (const n of numbers) {
    assert.strictEqual(Number.isNaN(n), false, 'no NaN in report numbers');
    assert.strictEqual(n, 0);
  }
  assert.deepStrictEqual(report.sourceRoi.bySource, []);
  assert.deepStrictEqual(report.leaderboard, []);
});

// ===========================================================================
// Ledger-integrity badge reflects verifyChain()
// ===========================================================================

test('F/ledger: integrity badge is valid intact, broken after tamper', async () => {
  await seed({ collected: 9000, costs: 5000 });

  let report = await analytics.buildReport();
  assert.strictEqual(report.ledger.valid, true);
  assert.strictEqual(report.ledger.brokenAt, -1);

  // Tamper with a past ledger entry's payload — the chain must break.
  const chain = await store.listRange('ledger');
  assert.ok(chain.length > 0, 'seed wrote ledger entries');
  chain[0].payload.actor = 'attacker';
  await store.set('ledger', chain);

  report = await analytics.buildReport();
  assert.strictEqual(report.ledger.valid, false);
  assert.strictEqual(report.ledger.brokenAt, 0);
});

// ===========================================================================
// /api/report — board-password gated, read-only JSON
// ===========================================================================

test('F/api: /api/report returns 401 without the board password', async () => {
  const r = await fetch(`${base}/api/report`);
  assert.strictEqual(r.status, 401);
  const d = await r.json();
  assert.match(d.error, /operator auth required/);
});

test('F/api: /api/report returns 200 JSON with the board password', async () => {
  await seed({ collected: 9000, costs: 5000 });
  const r = await fetch(`${base}/api/report`, { headers: BOARD });
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.totals.leads, 1);
  assert.strictEqual(d.totals.won, 1);
  assert.strictEqual(d.fee.total, 800);
  assert.strictEqual(d.ledger.valid, true);
  assert.ok(Array.isArray(d.funnel.stages));
});

test('F/api: wrong board password is rejected 401', async () => {
  const r = await fetch(`${base}/api/report`, { headers: { 'X-Board-Password': 'nope' } });
  assert.strictEqual(r.status, 401);
});
