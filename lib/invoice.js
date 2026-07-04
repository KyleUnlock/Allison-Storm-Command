'use strict';

/**
 * lib/invoice.js — E3 invoice/receipt artifact for a WON lead.
 *
 * The invoice is a pure, read-only projection of the lead's ALREADY-computed
 * billing (lead.won, produced by leads.computeBilling). It does NOT recompute
 * or re-widen the fee: the locked rule — 20% of PROFIT, known-customer $0,
 * out-of-90-day-window $0, strict hash-chained attribution — is owned by
 * leads.js and simply surfaced here. The artifact REFERENCES the original,
 * server-stamped, hash-chained attribution token + lead id so a fee can always
 * be traced back to the lead that earned it.
 *
 * The Texas 3-day right-to-cancel notice (lib/notices) is attached while the
 * transaction is still inside its cancellation window.
 */

const notices = require('./notices');
const dealTerms = require('./deal-terms');

// Conservative calendar approximation of the 3-business-day cancellation
// window. Business-day nuance is intentionally rounded toward showing the
// notice; the canonical wording lives in lib/notices.
const CANCEL_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Build the invoice artifact for a won lead. Throws NOT_WON if the lead is not
 * a won lead carrying computed billing. Pure (no store/ledger writes).
 */
function buildInvoice(lead, { serverNow = Date.now() } = {}) {
  if (!lead) {
    const err = new Error('lead required');
    err.code = 'NO_LEAD';
    throw err;
  }
  if (lead.status !== 'won' || !lead.won) {
    const err = new Error('lead is not won (no billing to invoice)');
    err.code = 'NOT_WON';
    throw err;
  }

  const won = lead.won;
  const fee = Number(won.fee || 0);
  const billable = fee > 0;

  // 3-day right-to-cancel applies while inside the window measured from the
  // (server-clamped) contract/sign date.
  const signMs = Date.parse(won.contractDate || won.wonAt || lead.deliveredAt);
  const sinceSign = serverNow - signMs;
  const cancelApplies =
    Number.isFinite(signMs) && sinceSign >= 0 && sinceSign <= CANCEL_WINDOW_MS;

  return {
    invoiceId: `inv_${lead.id}`,
    leadId: lead.id,
    // Strict attribution reference — the anchor the fee traces back to.
    attribution: {
      token: (lead.attribution && lead.attribution.token) || null,
      serverStamped: Boolean(lead.attribution && lead.attribution.serverStamped),
      stampedAt: (lead.attribution && lead.attribution.stampedAt) || null,
    },
    dealTerm: dealTerms.DEAL_TERM_SHORT, // "20% of profit"
    commissionRate: won.commissionRate,
    collected: won.collected,
    costs: won.costs,
    profit: won.profit,
    fee,
    billable,
    reason: won.reason, // billable | known-customer | outside-90d-window | no-profit | no-attribution
    lineItems: [{ description: `Platform fee (${dealTerms.DEAL_TERM_SHORT})`, amount: fee }],
    contractDate: won.contractDate,
    windowEnd: won.windowEnd,
    paymentStatus: lead.paymentStatus || 'unpaid',
    cancelNoticeApplies: cancelApplies,
    cancelNotice: cancelApplies ? notices.NOTICE_3DAY_CANCEL : null,
    cancelNoticeTitle: notices.NOTICE_3DAY_CANCEL_TITLE,
    issuedAt: new Date(serverNow).toISOString(),
  };
}

module.exports = { buildInvoice, CANCEL_WINDOW_MS };
