'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const dealTerms = require('../lib/deal-terms');
const leads = require('../lib/leads');

// The four money-term overclaim patterns MUST stay in lockstep with the ones in
// scripts/lint-copy.js. This local copy lets the test prove a planted overclaim
// gets flagged without shelling out to the linter.
const MONEY_BANNED = [
  /\b30\s*%/,
  /%\s*of\s*(the\s*)?revenue/i,
  /rev(enue)?[-\s]?share/i,
  /percentage\s+of\s+revenue/i,
];

function isFlagged(text) {
  return MONEY_BANNED.some((re) => re.test(text));
}

test('COMMISSION_RATE is single-sourced from lib/leads.js (0.20)', () => {
  assert.strictEqual(dealTerms.COMMISSION_RATE, leads.COMMISSION_RATE);
  assert.strictEqual(dealTerms.COMMISSION_RATE, 0.2);
});

test('formatFee(9000, 5000) === $800 (canonical 20%-of-profit example)', () => {
  assert.strictEqual(dealTerms.formatFee(9000, 5000), '$800');
});

test('formatFee is on PROFIT, not revenue (0 costs -> 20% of collected)', () => {
  assert.strictEqual(dealTerms.formatFee(1000, 0), '$200');
});

test('DEAL_TERM_SHORT says 20% of profit and never says revenue/30', () => {
  const s = dealTerms.DEAL_TERM_SHORT;
  assert.match(s, /20%/);
  assert.match(s, /profit/i);
  assert.doesNotMatch(s, /revenue/i);
  assert.doesNotMatch(s, /\b30\b/);
});

test('lint money patterns flag a planted "30% of revenue" overclaim', () => {
  assert.strictEqual(isFlagged('we take 30% of revenue'), true);
  assert.strictEqual(isFlagged('this is a revenue-share deal'), true);
  assert.strictEqual(isFlagged('a percentage of revenue'), true);
  // The canonical short wording must NOT be flagged.
  assert.strictEqual(isFlagged(dealTerms.DEAL_TERM_SHORT), false);
});
