'use strict';

/**
 * api/board.js — operator surface API for /board (table) and /crm (kanban).
 * Gated by BOARD_PASSWORD via lib/auth.isOperator. A rep session (alr_rep
 * cookie only) does NOT satisfy this gate -> 401.
 *
 * GET   -> all leads + stage buckets + Won dollar total.
 * PATCH -> the SHARED status-move path used by both the board and the CRM
 *          kanban drag/drop + touch <select> fallback. No new lib code.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const dnc = require('../lib/dnc');
const { readJson, sendJson } = require('../lib/http');

function view(lead) {
  const call = dnc.isCallable(lead);
  return {
    id: lead.id,
    status: lead.status,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    zip: lead.zip,
    address: lead.address,
    source: lead.source,
    assignedRep: lead.assignedRep,
    knownCustomer: lead.knownCustomer,
    callable: call.callable,
    callReason: call.reason,
    won: lead.won,
    createdAt: lead.createdAt,
  };
}

module.exports = async (req, res) => {
  if (!auth.isOperator(req)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }

  if (req.method === 'GET') {
    const all = (await leads.listLeads()).map(view);
    const wonTotal = all
      .filter((l) => l.status === 'won' && l.won)
      .reduce((sum, l) => sum + (l.won.collected || 0), 0);
    const feeTotal = all
      .filter((l) => l.won)
      .reduce((sum, l) => sum + (l.won.fee || 0), 0);
    return sendJson(res, 200, {
      stages: leads.STAGES,
      leads: all,
      wonTotal,
      feeTotal,
    });
  }

  if (req.method === 'PATCH' || req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    try {
      const updated = await leads.updateStatus(id, status, {
        actor: 'operator',
        collected: body.collected,
        costs: body.costs,
        contractDate: body.contractDate,
      });
      return sendJson(res, 200, { ok: true, lead: view(updated) });
    } catch (e) {
      const code =
        e.code === 'BAD_STATUS' ? 400 : e.code === 'NOT_FOUND' ? 404 : 500;
      return sendJson(res, code, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: 'method not allowed' });
};
