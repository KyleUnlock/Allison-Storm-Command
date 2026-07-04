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
const routing = require('../lib/routing');
const { readJson, sendJson } = require('../lib/http');

function view(lead) {
  const call = dnc.isCallable(lead);
  const sla = routing.checkSla(lead);
  return {
    id: lead.id,
    status: lead.status,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    zip: lead.zip,
    address: lead.address,
    source: lead.source,
    adSource: lead.adSource || null,
    campaign: lead.campaign || null,
    assignedRep: lead.assignedRep,
    knownCustomer: lead.knownCustomer,
    callable: call.callable,
    callReason: call.reason,
    won: lead.won,
    createdAt: lead.createdAt,
    // Phase C surfacing.
    score: lead.score == null ? null : lead.score,
    claim: lead.claim || null,
    assignedAt: lead.assignedAt || null,
    firstTouchAt: lead.firstTouchAt || null,
    slaBreached: sla.breached,
    sla,
  };
}

module.exports = async (req, res) => {
  if (!auth.isOperator(req)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }

  if (req.method === 'GET') {
    const all = (await leads.listLeads())
      .map(view)
      // Surface highest-priority leads first (C2 score).
      .sort((a, b) => (b.score || 0) - (a.score || 0));
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
    try {
      let updated = null;
      // C1: claim ladder edit rides the SAME operator-scoped PATCH path.
      if (body.claim && typeof body.claim === 'object') {
        updated = await leads.updateClaim(id, body.claim, { actor: 'operator' });
      }
      // Status move (existing behavior). Both may be present in one PATCH.
      if (body.status !== undefined && String(body.status) !== '') {
        updated = await leads.updateStatus(id, String(body.status), {
          actor: 'operator',
          collected: body.collected,
          costs: body.costs,
          contractDate: body.contractDate,
        });
      }
      if (!updated) {
        return sendJson(res, 400, { error: 'nothing to update' });
      }
      return sendJson(res, 200, { ok: true, lead: view(updated) });
    } catch (e) {
      const code =
        e.code === 'BAD_STATUS' || e.code === 'BAD_CLAIM_STATUS'
          ? 400
          : e.code === 'NOT_FOUND'
            ? 404
            : 500;
      return sendJson(res, code, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: 'method not allowed' });
};
