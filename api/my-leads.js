'use strict';

/**
 * api/my-leads.js — the rep field console API. Server-scoped:
 *   - identity comes from the signed `alr_rep` cookie, NEVER the body.
 *   - GET  returns only leads assigned to THIS rep (plus unclaimed leads
 *     they may claim); no cookie -> 401.
 *   - PATCH moves a lead's status but ONLY for the rep's own (or unclaimed)
 *     leads. assignedRep/actor are stamped from the session. Another rep's
 *     lead -> 403.
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
    notes: lead.notes,
    source: lead.source,
    assignedRep: lead.assignedRep,
    callable: call.callable,
    callReason: call.reason,
    won: lead.won,
  };
}

module.exports = async (req, res) => {
  const session = auth.repFromRequest(req);
  if (!session) return sendJson(res, 401, { error: 'rep auth required' });
  const rep = session.rep;

  if (req.method === 'GET') {
    const all = await leads.listLeads();
    const mine = all.filter(
      (l) => l.assignedRep === rep || l.assignedRep == null
    );
    return sendJson(res, 200, { rep, leads: mine.map(view) });
  }

  if (req.method === 'PATCH' || req.method === 'POST') {
    const body = await readJson(req);
    const id = String(body.id || '');
    const status = String(body.status || '');
    const lead = await leads.getLead(id);
    if (!lead) return sendJson(res, 404, { error: 'lead not found' });

    // scope: a rep may only touch their own or an unclaimed lead.
    if (lead.assignedRep && lead.assignedRep !== rep) {
      return sendJson(res, 403, { error: 'not your lead' });
    }

    // claim if unassigned — assignment is server-stamped from the session.
    if (!lead.assignedRep) {
      lead.assignedRep = rep;
      await leads.saveLead(lead);
    }

    try {
      const updated = await leads.updateStatus(id, status, {
        actor: rep, // from session, never body
        collected: body.collected,
        costs: body.costs,
        contractDate: body.contractDate,
      });
      return sendJson(res, 200, { ok: true, lead: view(updated) });
    } catch (e) {
      const code = e.code === 'BAD_STATUS' ? 400 : 500;
      return sendJson(res, code, { error: e.message });
    }
  }

  return sendJson(res, 405, { error: 'method not allowed' });
};
