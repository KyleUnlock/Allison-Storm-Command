'use strict';

/**
 * api/outreach-attempt.js — E2 consent-gated outreach endpoint.
 *
 * Operator (BOARD_PASSWORD) OR a rep session (alr_rep cookie) may POST an
 * outreach attempt. The actor is SERVER-derived (operator / rep name), never
 * from the body. A rep may only act on their own or an unclaimed lead. The
 * gate + logging live in lib/outreach — this handler NEVER dials or texts, and
 * there is no AI-voice path. A blocked attempt returns 200 with permitted:false
 * and the reason (both allowed + blocked are ledgered by lib/outreach).
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const outreach = require('../lib/outreach');
const { readJson, sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  const operator = auth.isOperator(req);
  const session = auth.repFromRequest(req);
  if (!operator && !session) {
    return sendJson(res, 401, { error: 'operator or rep auth required' });
  }

  const body = await readJson(req);
  const id = String(body.id || '');
  const lead = await leads.getLead(id);
  if (!lead) return sendJson(res, 404, { error: 'lead not found' });

  const actor = operator ? 'operator' : session.rep;
  // Rep scope: a rep may only reach out on their own or an unclaimed lead.
  if (!operator && lead.assignedRep && lead.assignedRep !== session.rep) {
    return sendJson(res, 403, { error: 'not your lead' });
  }

  try {
    const result = await outreach.attempt(lead, {
      channel: body.channel,
      actor,
      message: body.message,
    });
    return sendJson(res, 200, result);
  } catch (e) {
    const code = e.code === 'BAD_CHANNEL' ? 400 : 500;
    return sendJson(res, code, { error: e.message });
  }
};
