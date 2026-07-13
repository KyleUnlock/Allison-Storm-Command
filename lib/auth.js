'use strict';

/**
 * lib/auth.js — server-scoped auth for reps + operators.
 *
 * Reps: HMAC-signed `alr_rep` cookie carrying { rep, iat }. Reps authenticate
 * ONLY against REP_CREDENTIALS ("name:passcode,name2:passcode2"), never the
 * shared BOARD_PASSWORD. The signed cookie is the source of truth for who a
 * rep is — assignedRep/actor are read from it, never from a request body.
 *
 * Operators: a single BOARD_PASSWORD gates /board, /crm and api/board.
 */

const crypto = require('crypto');

const REP_COOKIE = 'alr_rep';

// In production the convenience dev-defaults below MUST NOT apply: this repo is
// public, so a default session key / board password would let anyone forge an
// operator cookie or log into the board. On Vercel production (or NODE_ENV=
// production) we return null when the secret is unset, and every auth path
// treats null as "deny" — the app fails CLOSED rather than falling back to a
// public value. Local dev + offline tests keep the defaults so they run with
// no env. Set SESSION_SECRET + BOARD_PASSWORD in the Vercel project to enable
// the operator/rep surfaces in production.
function isProd() {
  return process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
}

function sessionSecret() {
  if (isProd()) return process.env.SESSION_SECRET || null;
  return process.env.SESSION_SECRET || 'local-session-secret';
}

function boardPassword() {
  if (isProd()) return process.env.BOARD_PASSWORD || null;
  return process.env.BOARD_PASSWORD || 'AllisonStorm-Cmd-2026';
}

// ---- rep credentials --------------------------------------------------------
function repCredentials() {
  const raw = process.env.REP_CREDENTIALS || '';
  const map = new Map();
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const pass = pair.slice(idx + 1).trim();
    if (name && pass) map.set(name, pass);
  }
  return map;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Validate rep name+passcode against REP_CREDENTIALS. */
function verifyRep(name, passcode) {
  const creds = repCredentials();
  if (!creds.has(name)) return false;
  return timingSafeEqual(creds.get(name), passcode);
}

// ---- signed rep cookie ------------------------------------------------------
function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('hex');
}

function issueRepToken(rep) {
  // Fail closed in production without a real signing key — never mint a token
  // signed with a public default that anyone could forge.
  if (!sessionSecret()) throw new Error('SESSION_SECRET is required to issue rep sessions in production');
  const payload = Buffer.from(JSON.stringify({ rep, iat: Date.now() })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

/** Returns { rep } if the token is authentic, else null. */
function verifyRepToken(token) {
  if (!sessionSecret()) return null; // prod without SESSION_SECRET → no session verifiable
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!timingSafeEqual(sign(payload), sig)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.rep) return null;
    return { rep: data.rep };
  } catch {
    return null;
  }
}

// ---- cookie helpers ---------------------------------------------------------
function parseCookies(req) {
  const header = req.headers && (req.headers.cookie || req.headers.Cookie);
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function repCookieHeader(token) {
  // Secure in production so the session token is never transmitted over
  // cleartext HTTP; omitted in local dev so http://localhost testing works.
  const secure = isProd() ? '; Secure' : '';
  return `${REP_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure}`;
}

/** Read + verify the rep session from the request cookies. Server-scoped. */
function repFromRequest(req) {
  const token = parseCookies(req)[REP_COOKIE];
  return verifyRepToken(token);
}

// ---- operator gate ----------------------------------------------------------
function readBearerOrPassword(req) {
  // Accept operator password via X-Board-Password header, Bearer, or ?pw=.
  const h = req.headers || {};
  if (h['x-board-password']) return String(h['x-board-password']);
  const auth = h.authorization || h.Authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '');
  return null;
}

function isOperator(req, passwordFromBody) {
  const expected = boardPassword();
  if (expected == null) return false; // prod without BOARD_PASSWORD → board locked
  const supplied = readBearerOrPassword(req) || passwordFromBody || null;
  if (supplied == null) return false;
  return timingSafeEqual(supplied, expected);
}

module.exports = {
  REP_COOKIE,
  boardPassword,
  repCredentials,
  verifyRep,
  issueRepToken,
  verifyRepToken,
  repFromRequest,
  repCookieHeader,
  parseCookies,
  isOperator,
};
