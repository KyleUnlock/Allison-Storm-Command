'use strict';

/**
 * api/rep-login.js — rep authentication. Reps authenticate ONLY against
 * REP_CREDENTIALS ("name:passcode,..."), NEVER the shared BOARD_PASSWORD.
 * Success issues the HMAC-signed `alr_rep` cookie.
 */

const auth = require('../lib/auth');
const { readJson, sendJson } = require('../lib/http');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  const passcode = String(body.passcode || '');

  if (!name || !passcode || !auth.verifyRep(name, passcode)) {
    return sendJson(res, 401, { error: 'invalid rep credentials' });
  }

  const token = auth.issueRepToken(name);
  return sendJson(res, 200, { ok: true, rep: name }, {
    'Set-Cookie': auth.repCookieHeader(token),
  });
};
