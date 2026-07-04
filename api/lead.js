'use strict';

/**
 * api/lead.js — single lead detail. Gated: an operator (BOARD_PASSWORD) OR the
 * rep the lead is assigned to may read it. Uses WHATWG URL for the ?id= query.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const dnc = require('../lib/dnc');
const { sendJson, urlOf } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const id = urlOf(req).searchParams.get('id');
  if (!id) return sendJson(res, 400, { error: 'id required' });

  const lead = await leads.getLead(id);
  if (!lead) return sendJson(res, 404, { error: 'lead not found' });

  const operator = auth.isOperator(req);
  const session = auth.repFromRequest(req);
  const ownRep = session && lead.assignedRep === session.rep;
  if (!operator && !ownRep) {
    return sendJson(res, 401, { error: 'auth required' });
  }

  const call = dnc.isCallable(lead);
  return sendJson(res, 200, {
    lead: { ...lead, callable: call.callable, callReason: call.reason },
  });
};
