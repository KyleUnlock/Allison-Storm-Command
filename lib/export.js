'use strict';

/**
 * lib/export.js — operator CSV export with the DNC fail-safe baked in.
 *
 * The ONE rule: a phone number leaves the export ONLY when the lead is callable
 * per lib/dnc.js. Every non-callable lead (unscrubbed cold, hard-DNC, or
 * withheld because no provider is configured) has its phone REDACTED. Because
 * lib/dnc withholds every cold number when DNC_PROVIDER is unset, the export
 * likewise withholds every cold phone by default — the correct, intended
 * behavior, not a bug. No un-scrubbed phone can ever leave via this path.
 */

const dnc = require('./dnc');

const REDACTED = '[withheld]';

const COLUMNS = [
  'id',
  'status',
  'source',
  'name',
  'phone',
  'email',
  'zip',
  'address',
  'assignedRep',
  'knownCustomer',
  'callable',
  'callReason',
  'createdAt',
];

/**
 * exportPhone(lead) -> string. The single fail-safe filter. Returns the phone
 * digits ONLY when dnc.isCallable(lead).callable is true; otherwise the number
 * is redacted. A lead with no phone yields an empty cell (nothing to redact).
 */
function exportPhone(lead) {
  if (!lead || !lead.phone) return '';
  return dnc.isCallable(lead).callable ? String(lead.phone) : REDACTED;
}

/** Build the flat, export-safe row object for one lead. */
function toRow(lead) {
  const call = dnc.isCallable(lead);
  return {
    id: lead.id || '',
    status: lead.status || '',
    source: lead.source || '',
    name: lead.name || '',
    phone: exportPhone(lead),
    email: lead.email || '',
    zip: lead.zip || '',
    address: lead.address || '',
    assignedRep: lead.assignedRep || '',
    knownCustomer: lead.knownCustomer ? 'yes' : 'no',
    callable: call.callable ? 'yes' : 'no',
    callReason: call.reason,
    createdAt: lead.createdAt || '',
  };
}

// RFC-4180-ish cell escaping.
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Render the full CSV (header + one row per lead) with phones filtered. */
function toCsv(leadList) {
  const header = COLUMNS.join(',');
  const rows = (leadList || []).map((lead) => {
    const row = toRow(lead);
    return COLUMNS.map((c) => csvCell(row[c])).join(',');
  });
  return [header, ...rows].join('\r\n') + '\r\n';
}

module.exports = { toCsv, toRow, exportPhone, REDACTED, COLUMNS };
