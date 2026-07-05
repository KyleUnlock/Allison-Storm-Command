'use strict';

/**
 * test/auth-prod-hardening.test.js — the public-default secrets must NEVER
 * take effect in production. This repo is public, so a default SESSION_SECRET
 * or BOARD_PASSWORD would let anyone forge an operator cookie / log into the
 * board. In prod (VERCEL_ENV=production or NODE_ENV=production) the auth paths
 * fail CLOSED when the secret is unset; local/dev keeps the defaults.
 */

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const auth = require('../lib/auth');

const SAVED = {
  VERCEL_ENV: process.env.VERCEL_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
  BOARD_PASSWORD: process.env.BOARD_PASSWORD,
};

function restore() {
  for (const k of Object.keys(SAVED)) {
    if (SAVED[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED[k];
  }
}
afterEach(restore);

const reqWithPw = (pw) => ({ headers: { 'x-board-password': pw } });

test('PROD without secrets → operator board is LOCKED (no public-default fallback)', () => {
  process.env.VERCEL_ENV = 'production';
  delete process.env.SESSION_SECRET;
  delete process.env.BOARD_PASSWORD;

  // The default that ships in the public repo must NOT work.
  assert.strictEqual(auth.isOperator(reqWithPw('AllisonStorm-Cmd-2026')), false);
  assert.strictEqual(auth.boardPassword(), null);
  // No rep session is verifiable, and none can be minted.
  assert.strictEqual(auth.verifyRepToken('anything.forged'), null);
  assert.throws(() => auth.issueRepToken('terrell'), /SESSION_SECRET is required/);
});

test('PROD with real secrets → board works, rep token round-trips', () => {
  process.env.VERCEL_ENV = 'production';
  process.env.SESSION_SECRET = 'a-real-64-char-secret-value-set-in-vercel-xxxxxxxxxxxxxxxxxxxx';
  process.env.BOARD_PASSWORD = 'a-real-operator-password';

  assert.strictEqual(auth.isOperator(reqWithPw('a-real-operator-password')), true);
  assert.strictEqual(auth.isOperator(reqWithPw('wrong')), false);
  assert.strictEqual(auth.isOperator(reqWithPw('AllisonStorm-Cmd-2026')), false);

  const token = auth.issueRepToken('terrell');
  assert.deepStrictEqual(auth.verifyRepToken(token), { rep: 'terrell' });
});

test('DEV/offline (no prod env) → dev defaults still apply so tests/local run env-free', () => {
  delete process.env.VERCEL_ENV;
  delete process.env.NODE_ENV;
  delete process.env.SESSION_SECRET;
  delete process.env.BOARD_PASSWORD;

  assert.strictEqual(auth.boardPassword(), 'AllisonStorm-Cmd-2026');
  assert.strictEqual(auth.isOperator(reqWithPw('AllisonStorm-Cmd-2026')), true);
  const token = auth.issueRepToken('dev');
  assert.deepStrictEqual(auth.verifyRepToken(token), { rep: 'dev' });
});
