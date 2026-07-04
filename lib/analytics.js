'use strict';

/**
 * lib/analytics.js — READ-ONLY reporting over the leads index + ledger.
 *
 * Pure aggregation: it fetches leads (lib/leads.listLeads) and the ledger
 * (lib/ledger.all) from the store and rolls them up into a single report
 * object. It NEVER mutates a lead or the ledger, makes NO external calls, and
 * adds no transports — every number derives from KV state already written by
 * the lifecycle/webhook/billing paths.
 *
 * Money rule is inherited verbatim from lib/leads: the platform fee is 20% of
 * PROFIT (collected revenue minus direct job costs). Every won lead already
 * carries that fee in `lead.won.fee` (computed by leads.computeBilling); this
 * module only sums what is there. It is NEVER a cut of revenue.
 *
 * All rates guard divide-by-zero: 0 leads ⇒ rates 0 (never NaN).
 */

const leads = require('./leads');
const ledger = require('./ledger');
const routing = require('./routing');
const { COMMISSION_RATE, DEAL_TERM_SHORT } = require('./deal-terms');

const STAGES = leads.STAGES;
const STAGE_INDEX = new Map(STAGES.map((s, i) => [s, i]));
const WON_INDEX = STAGE_INDEX.get('won');

// Safe divide: returns 0 (never NaN/Infinity) when the denominator is 0.
function rate(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 10000) / 10000;
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;
}

function avg(nums) {
  if (!nums.length) return 0;
  return Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100;
}

// A lead has reached a stage when its current status index is >= that stage's.
function stageIdx(lead) {
  const i = STAGE_INDEX.get(lead.status);
  return i == null ? -1 : i;
}

// A lead counts as won when the billing record exists OR the pipeline advanced
// to won/production/completed — the two signals agree in normal flow.
function isWon(lead) {
  return Boolean(lead.won) || stageIdx(lead) >= WON_INDEX;
}

/**
 * Funnel: current count at each stage, cumulative reach, and adjacent
 * stage→stage conversion, plus the overall lead→won rate.
 */
function buildFunnel(all) {
  const total = all.length;
  const count = Object.fromEntries(STAGES.map((s) => [s, 0]));
  for (const l of all) {
    if (count[l.status] != null) count[l.status] += 1;
  }
  // Cumulative reach: leads at or beyond each stage index.
  const reached = STAGES.map((_, i) => all.filter((l) => stageIdx(l) >= i).length);

  const stages = STAGES.map((stage, i) => ({
    stage,
    count: count[stage],
    reached: reached[i],
    // Conversion from the previous stage's reach into this stage's reach.
    conversionFromPrev: i === 0 ? 1 : rate(reached[i], reached[i - 1]),
  }));

  const wonReached = all.filter(isWon).length;
  return { stages, total, wonReached, overallWonRate: rate(wonReached, total) };
}

// Generic ROI aggregator over a keying function. Skips leads with no key.
function groupRoi(all, keyOf) {
  const map = new Map();
  for (const l of all) {
    const key = keyOf(l);
    if (key == null || key === '') continue;
    let g = map.get(key);
    if (!g) {
      g = { key, leads: 0, won: 0, profit: 0, fee: 0 };
      map.set(key, g);
    }
    g.leads += 1;
    if (l.won) {
      g.won += 1;
      g.profit += Number(l.won.profit || 0);
      g.fee += Number(l.won.fee || 0);
    }
  }
  return [...map.values()]
    .map((g) => ({
      ...g,
      profit: Math.round(g.profit * 100) / 100,
      fee: Math.round(g.fee * 100) / 100,
      wonRate: rate(g.won, g.leads),
    }))
    .sort((a, b) => b.fee - a.fee || b.won - a.won || b.leads - a.leads);
}

// A single human-readable campaign label from the sanitized campaign tag.
function campaignLabel(lead) {
  const c = lead.campaign;
  if (!c || typeof c !== 'object') return null;
  return c.campaign || c.campaignId || c.campaign_id || c.name || null;
}

function buildSourceRoi(all) {
  return {
    bySource: groupRoi(all, (l) => l.source || 'unknown'),
    byAdSource: groupRoi(all, (l) => l.adSource || null),
    byCampaign: groupRoi(all, campaignLabel),
  };
}

/**
 * SLA: first-touch breach rate + first-touch latency (minutes) stats.
 * breached is computed via routing.checkSla so it matches the operator surface.
 */
function buildSla(all, now) {
  const total = all.length;
  let breached = 0;
  const latencies = [];
  for (const l of all) {
    const sla = routing.checkSla(l, { now });
    if (sla.breached === true) breached += 1;
    if (sla.touched && typeof sla.minutesToTouch === 'number') {
      latencies.push(sla.minutesToTouch);
    }
  }
  return {
    total,
    breached,
    breachRate: rate(breached, total),
    touchedCount: latencies.length,
    medianMinutes: median(latencies),
    avgMinutes: avg(latencies),
  };
}

/**
 * Rep leaderboard: per assignedRep — assigned, worked (has firstTouchAt), won,
 * and total UnlockAI fee (20% of profit). Unassigned leads are excluded.
 */
function buildLeaderboard(all) {
  const map = new Map();
  for (const l of all) {
    const rep = l.assignedRep;
    if (!rep) continue;
    let g = map.get(rep);
    if (!g) {
      g = { rep, assigned: 0, worked: 0, won: 0, fee: 0 };
      map.set(rep, g);
    }
    g.assigned += 1;
    if (l.firstTouchAt) g.worked += 1;
    if (l.won) {
      g.won += 1;
      g.fee += Number(l.won.fee || 0);
    }
  }
  return [...map.values()]
    .map((g) => ({ ...g, fee: Math.round(g.fee * 100) / 100 }))
    .sort((a, b) => b.fee - a.fee || b.won - a.won || b.assigned - a.assigned);
}

/**
 * Build the full read-only report. `opts.now` lets tests pin the clock for SLA.
 */
async function buildReport(opts = {}) {
  const now = opts.now || Date.now();
  const all = await leads.listLeads();
  const chain = await ledger.all();

  const wonLeads = all.filter((l) => l.won);
  const wonCollected = wonLeads.reduce((s, l) => s + Number(l.won.collected || 0), 0);
  const wonProfit = wonLeads.reduce((s, l) => s + Number(l.won.profit || 0), 0);
  // UnlockAI fee roll-up: sum of the locked 20%-of-profit fee across won leads.
  const feeTotal = wonLeads.reduce((s, l) => s + Number(l.won.fee || 0), 0);

  const funnel = buildFunnel(all);

  return {
    generatedAt: new Date(now).toISOString(),
    totals: {
      leads: all.length,
      won: wonLeads.length,
      wonRate: funnel.overallWonRate,
      wonCollected: Math.round(wonCollected * 100) / 100,
      wonProfit: Math.round(wonProfit * 100) / 100,
    },
    funnel,
    sourceRoi: buildSourceRoi(all),
    sla: buildSla(all, now),
    leaderboard: buildLeaderboard(all),
    // Tamper-evident ledger integrity badge.
    ledger: ledger.verifyChain(chain),
    // UnlockAI fee roll-up — 20% of PROFIT, never a cut of revenue.
    fee: {
      commissionRate: COMMISSION_RATE,
      term: DEAL_TERM_SHORT,
      total: Math.round(feeTotal * 100) / 100,
    },
  };
}

module.exports = {
  buildReport,
  buildFunnel,
  buildSourceRoi,
  buildSla,
  buildLeaderboard,
  groupRoi,
  campaignLabel,
  isWon,
  rate,
  median,
  avg,
};
