'use strict';

/**
 * api/invoice.js — E3 invoice/receipt read endpoint. Operator-gated (billing is
 * an operator concern). GET ?id= -> the invoice artifact for a WON lead. A lead
 * that is not won returns 409 (no billing to invoice). The artifact references
 * the lead's original hash-chained attribution and reuses the locked billing.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const invoice = require('../lib/invoice');
const { sendJson, urlOf } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (!auth.isOperator(req)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }
  const id = urlOf(req).searchParams.get('id');
  if (!id) return sendJson(res, 400, { error: 'id required' });

  const lead = await leads.getLead(id);
  if (!lead) return sendJson(res, 404, { error: 'lead not found' });

  try {
    return sendJson(res, 200, { invoice: invoice.buildInvoice(lead) });
  } catch (e) {
    const code = e.code === 'NOT_WON' ? 409 : 500;
    return sendJson(res, code, { error: e.message });
  }
};
