'use strict';

/**
 * lib/notices.js — canonical customer-facing compliance notices.
 *
 * Single source of truth for the Texas home-solicitation THREE-DAY right to
 * cancel (Bus. & Com. Code ch. 601). Customer artifacts (notice.html, and any
 * future receipt surface) embed these verbatim; scripts/lint-copy.js asserts
 * the marker is present wherever the notice is required. Wording is accurate
 * and makes no overclaims.
 */

const NOTICE_3DAY_CANCEL_TITLE = 'Your Three-Day Right to Cancel';

const NOTICE_3DAY_CANCEL =
  'You, the buyer, may cancel this transaction at any time prior to midnight of the ' +
  'third business day after the date of this transaction. To cancel, deliver or mail a ' +
  'signed and dated written notice — or send any other written statement that you do not ' +
  'wish to be bound — to Allison Roofing at the address on your agreement before that ' +
  'deadline. If you cancel in time, any payments you made will be returned within ten ' +
  'business days and any security interest arising out of the transaction will be cancelled.';

// Distinctive substring the copy linter requires on the notice surface.
const NOTICE_3DAY_CANCEL_MARKER = 'third business day';

module.exports = {
  NOTICE_3DAY_CANCEL_TITLE,
  NOTICE_3DAY_CANCEL,
  NOTICE_3DAY_CANCEL_MARKER,
};
