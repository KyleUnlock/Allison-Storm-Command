'use strict';

/**
 * lib/notify.js — internal-only, fail-safe operator notifications.
 *
 * FAIL-SAFE CONTRACT: this module NEVER throws and NEVER blocks a lead. When
 * RESEND_API_KEY or NOTIFY_TO is unset it no-ops cleanly (logs intent, returns
 * { sent:false, reason:'no-config' }). Any transport error is swallowed and
 * reported in the return value — a notification failure must never fail a lead
 * write.
 *
 * RECIPIENT is ALWAYS the internal NOTIFY_TO address. Nothing here is ever sent
 * to a homeowner; there is deliberately no code path that addresses a lead's
 * own phone/email.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const FROM = 'Allison Storm Command <alerts@allison-storm.local>';

function config() {
  return {
    key: process.env.RESEND_API_KEY || '',
    to: process.env.NOTIFY_TO || '',
  };
}

function configured() {
  const { key, to } = config();
  return Boolean(key && to);
}

/**
 * Low-level send. Always resolves (never rejects). Returns
 * { sent:boolean, reason?:string }.
 */
async function send({ subject, text }) {
  const { key, to } = config();
  if (!key || !to) {
    // Intent is logged so operators can see what WOULD have gone out.
    console.log(`[notify] no-op (RESEND_API_KEY/NOTIFY_TO unset): ${subject}`);
    return { sent: false, reason: 'no-config' };
  }
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      // `to` is the internal NOTIFY_TO only — never a homeowner address.
      body: JSON.stringify({ from: FROM, to: [to], subject, text }),
    });
    if (!res.ok) return { sent: false, reason: `http-${res.status}` };
    return { sent: true };
  } catch (e) {
    console.log(`[notify] send failed (non-blocking): ${e.message}`);
    return { sent: false, reason: 'error' };
  }
}

/** New-lead alert to the internal inbox. */
async function notifyNewLead(lead) {
  if (!lead) return { sent: false, reason: 'no-lead' };
  return send({
    subject: `New lead ${lead.id} (${lead.source || 'web'})`,
    text:
      `New lead ${lead.id}\n` +
      `Source: ${lead.source || 'web'}\n` +
      `ZIP: ${lead.zip || '?'}\n` +
      `Score: ${lead.score == null ? '?' : lead.score}\n` +
      `Assigned: ${lead.assignedRep || 'unassigned'}`,
  });
}

/** SLA first-touch breach alert to the internal inbox. */
async function notifySlaBreach(lead) {
  if (!lead) return { sent: false, reason: 'no-lead' };
  return send({
    subject: `SLA breach: lead ${lead.id} awaiting first touch`,
    text:
      `Lead ${lead.id} assigned ${lead.assignedAt || '?'} to ` +
      `${lead.assignedRep || 'unassigned'} has breached the first-touch SLA.`,
  });
}

module.exports = { send, notifyNewLead, notifySlaBreach, configured };
