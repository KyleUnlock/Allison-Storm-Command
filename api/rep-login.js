'use strict';

/**
 * api/rep-login.js — rep authentication. Reps authenticate ONLY against
 * REP_CREDENTIALS ("name:passcode,..."), NEVER the shared BOARD_PASSWORD.
 * Success issues the HMAC-signed `alr_rep` cookie.
 *
 * Brute-force throttle: a fixed-window limiter caps FAILED attempts per client
 * IP and per rep name (5 / 10 min). It fails open on a KV error so a store blip
 * never locks out a legitimate rep, and a successful login clears both counters.
 */

const auth = require('../lib/auth');
const rl = require('../lib/ratelimit');
const { readJson, sendJson } = require('../lib/http');

const MAX_FAILS = 5;
const WINDOW_MS = 10 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  const body = await readJson(req);
  const name = String(body.name || '').trim();
  const passcode = String(body.passcode || '');

  const ip = rl.clientIp(req);
  const ipKey = `rl:replogin:ip:${ip}`;
  const repKey = `rl:replogin:rep:${name || 'unknown'}`;

  if (
    (await rl.isBlocked(ipKey, { max: MAX_FAILS })) ||
    (await rl.isBlocked(repKey, { max: MAX_FAILS }))
  ) {
    return sendJson(res, 429, { error: 'too many attempts; try again later' });
  }

  if (!name || !passcode || !auth.verifyRep(name, passcode)) {
    await rl.hit(ipKey, { max: MAX_FAILS, windowMs: WINDOW_MS });
    await rl.hit(repKey, { max: MAX_FAILS, windowMs: WINDOW_MS });
    return sendJson(res, 401, { error: 'invalid rep credentials' });
  }

  // Clean login — reset the throttle so a good rep is never penalized.
  await rl.clear(ipKey);
  await rl.clear(repKey);

  const token = auth.issueRepToken(name);
  return sendJson(res, 200, { ok: true, rep: name }, {
    'Set-Cookie': auth.repCookieHeader(token),
  });
};
