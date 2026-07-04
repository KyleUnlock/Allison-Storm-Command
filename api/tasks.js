'use strict';

/**
 * api/tasks.js — operator-gated worklist. Derives actionable tasks from lead
 * state (uncontacted new leads, cold leads pending a DNC scrub, stale Won
 * without billing). Uses WHATWG URL (never url.parse) for query filters.
 */

const auth = require('../lib/auth');
const leads = require('../lib/leads');
const dnc = require('../lib/dnc');
const { sendJson, urlOf } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (!auth.isOperator(req)) {
    return sendJson(res, 401, { error: 'operator auth required' });
  }

  const u = urlOf(req);
  const repFilter = u.searchParams.get('rep');

  const all = await leads.listLeads();
  const tasks = [];

  for (const lead of all) {
    if (repFilter && lead.assignedRep !== repFilter) continue;
    if (lead.status === 'new') {
      tasks.push({ leadId: lead.id, kind: 'contact', label: 'New lead — make first contact' });
    }
    const call = dnc.isCallable(lead);
    if (!call.callable && call.reason.startsWith('withheld')) {
      tasks.push({ leadId: lead.id, kind: 'scrub', label: 'Cold lead withheld — needs DNC scrub' });
    }
    if (lead.status === 'won' && lead.won && lead.won.reason !== 'billable' && lead.won.reason !== 'known-customer') {
      tasks.push({ leadId: lead.id, kind: 'review', label: `Won but $0 fee (${lead.won.reason})` });
    }
  }

  return sendJson(res, 200, { count: tasks.length, tasks });
};
