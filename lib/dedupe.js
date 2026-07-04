'use strict';

/**
 * lib/dedupe.js — duplicate detection + attribution-preserving merge.
 *
 * A duplicate is two leads that share the SAME normalized phone AND normalized
 * street address. The merge is deliberately conservative:
 *
 *   - The PRIMARY (survivor) is the EARLIEST server-stamped lead — the one whose
 *     attribution token anchors the 90-day billing window. Its id and its
 *     `attribution` object are NEVER rewritten, so strict attribution and the
 *     hash-chained ledger stay intact (merge only APPENDS a `lead.merged`
 *     event; it never mutates a prior ledger entry, so ledger.verifyChain()
 *     continues to hold).
 *   - Missing primary contact fields are enriched from the secondary (fill-only,
 *     never overwrite) so no data is lost.
 *   - The SECONDARY is flagged `merged:true` + `mergedInto:<primary id>` and
 *     kept for auditability rather than deleted.
 */

const sanitize = require('./sanitize');
const ledger = require('./ledger');
const leads = require('./leads');

const ENRICH_FIELDS = ['name', 'phone', 'email', 'zip', 'address', 'notes'];

function normAddress(addr) {
  return String(addr || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Composite dedupe key: normalized phone + normalized address. Returns '' when
 * the lead carries neither (nothing to match on -> never a duplicate).
 */
function dedupeKey(lead) {
  if (!lead) return '';
  const phone = sanitize.cleanPhone(lead.phone);
  const addr = normAddress(lead.address);
  if (!phone && !addr) return '';
  return `${phone}|${addr}`;
}

/** True when two leads normalize to the same non-empty key. */
function isDuplicate(a, b) {
  const ka = dedupeKey(a);
  const kb = dedupeKey(b);
  return Boolean(ka) && ka === kb;
}

function stampMs(lead) {
  return (
    Date.parse((lead.attribution && lead.attribution.stampedAt) || lead.createdAt || '') ||
    Number.MAX_SAFE_INTEGER
  );
}

/** Order a pair so the earliest server-stamped lead is primary. */
function orderByStamp(a, b) {
  return stampMs(a) <= stampMs(b) ? [a, b] : [b, a];
}

/**
 * Pure merge: pick the earliest as primary, fill-enrich its missing fields from
 * the secondary, and return { primary, secondary }. Does NOT persist. The
 * primary's id + attribution are left untouched.
 */
function mergeLeads(a, b) {
  const [primary, secondary] = orderByStamp(a, b);
  for (const f of ENRICH_FIELDS) {
    if (!primary[f] && secondary[f]) primary[f] = secondary[f];
  }
  return { primary, secondary };
}

/**
 * Persisting merge: enrich + save the primary, flag + save the secondary, and
 * append a single `lead.merged` ledger event. Attribution and prior ledger
 * entries are never rewritten, so verifyChain() still holds afterward.
 */
async function mergeAndPersist(a, b, { actor = 'system' } = {}) {
  const { primary, secondary } = mergeLeads(a, b);
  secondary.merged = true;
  secondary.mergedInto = primary.id;
  primary.mergedFrom = Array.from(
    new Set([...(primary.mergedFrom || []), secondary.id])
  );
  await leads.saveLead(primary);
  await leads.saveLead(secondary);
  await ledger.append({
    type: 'lead.merged',
    leadId: primary.id,
    actor,
    data: { mergedFrom: secondary.id, into: primary.id },
  });
  return { primary, secondary };
}

/**
 * Scan a list of leads and return duplicate groups (each an array of >=2 leads
 * sharing a key), earliest-first within each group.
 */
function findDuplicateGroups(list) {
  const byKey = new Map();
  for (const lead of list) {
    const k = dedupeKey(lead);
    if (!k) continue;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(lead);
  }
  const groups = [];
  for (const group of byKey.values()) {
    if (group.length > 1) {
      groups.push(group.slice().sort((x, y) => stampMs(x) - stampMs(y)));
    }
  }
  return groups;
}

module.exports = {
  dedupeKey,
  normAddress,
  isDuplicate,
  mergeLeads,
  mergeAndPersist,
  findDuplicateGroups,
  ENRICH_FIELDS,
};
