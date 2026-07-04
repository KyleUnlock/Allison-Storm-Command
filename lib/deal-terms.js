'use strict';

/**
 * lib/deal-terms.js — the ONE canonical, code-true source for how the deal
 * term is worded anywhere in the app.
 *
 * The locked commission is 20% of PROFIT (collected revenue minus direct job
 * costs). It is NEVER a percentage of revenue and NEVER 30%. To avoid a second
 * source of truth, the numeric rate is imported from lib/leads.js — that module
 * owns the 0.20 the billing math actually uses; this file only names it.
 *
 * NOTE FOR THE COPY LINTER: this file is the single allowed place where the
 * banned money-overclaim phrasings may appear (in DEAL_TERM_LONG, as an
 * explicit disclaimer). scripts/lint-copy.js exempts this file from the
 * money-term patterns; every other page/handler must use DEAL_TERM_SHORT.
 */

const { COMMISSION_RATE } = require('./leads');

// Short label for operator/rep surfaces, e.g. "Fees (20% of profit)".
const DEAL_TERM_SHORT = '20% of profit';

// Full disclaimer wording. Contains the "never a percentage of revenue"
// disclaimer on purpose — only this file may.
const DEAL_TERM_LONG =
  '20% of profit — collected revenue minus direct job costs. Never a percentage of revenue.';

/**
 * formatFee(collected, directCosts) -> string dollar fee.
 *
 * Reuses the exact billing math shape from lib/leads.js: profit is clamped at
 * zero and the fee is round(profit * COMMISSION_RATE) to the cent. Canonical
 * example: formatFee(9000, 5000) === '$800'.
 */
function formatFee(collected, directCosts) {
  const profit = Math.max(0, Number(collected || 0) - Number(directCosts || 0));
  const fee = Math.round(profit * COMMISSION_RATE * 100) / 100;
  return '$' + fee.toLocaleString('en-US');
}

module.exports = {
  COMMISSION_RATE,
  DEAL_TERM_SHORT,
  DEAL_TERM_LONG,
  formatFee,
};
