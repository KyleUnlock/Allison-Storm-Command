'use strict';

/**
 * test/phaseg.test.js — Phase G: enablement & launch hardening (OFFLINE).
 *
 * Fences under test:
 *  - `npm run preflight` exits NON-ZERO when a required fence env is unset and
 *    ZERO when all required are set — and it NEVER prints a secret value.
 *  - /api/health returns 200 { ok:true } with the { checks:{ store, ledger } }
 *    shape and leaks NO lead/PII fields (no name/phone/email/address/won/etc.).
 *  - the staged enablement docs contain no banned money phrasing (mirrors
 *    scripts/lint-copy.js MONEY_BANNED) and no secret-looking literals.
 *
 * Read-only: no lead/ledger mutation; preflight runs in a child process so the
 * parent env is untouched.
 */

process.env.BOARD_PASSWORD = 'AllisonStorm-Cmd-2026';
process.env.SESSION_SECRET = 'test-session-secret';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const server = require('../serve.local');

const ROOT = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(ROOT, 'scripts', 'preflight.js');

const REQUIRED = [
  'SESSION_SECRET',
  'LEDGER_SECRET',
  'KV_REST_API_URL',
  'KV_REST_API_TOKEN',
  'BOARD_PASSWORD',
];

// A sentinel we can grep the child output for — if preflight ever echoes a
// value, this string leaks and the test fails.
const SENTINEL = 'SECRETVALUE-DO-NOT-PRINT-abc123XYZ';

// Run preflight in a clean, controlled env (no inherited real secrets).
function runPreflight(env) {
  return spawnSync(process.execPath, [PREFLIGHT], {
    cwd: ROOT,
    env, // exact env, not merged with process.env
    encoding: 'utf8',
  });
}

function allRequiredEnv() {
  const env = { PATH: process.env.PATH };
  for (const name of REQUIRED) env[name] = SENTINEL;
  return env;
}

let base;
before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// ===========================================================================
// preflight — fail on missing required, pass when all set, never leak a value
// ===========================================================================

test('G/preflight: exits non-zero when a required env is unset', () => {
  for (const missing of REQUIRED) {
    const env = allRequiredEnv();
    delete env[missing];
    const r = runPreflight(env);
    assert.strictEqual(r.status !== 0, true, `missing ${missing} must fail`);
    const out = r.stdout + r.stderr;
    assert.match(out, new RegExp(`${missing}[^\\n]*MISSING`), `names ${missing} as missing`);
    assert.match(out, /preflight FAILED/);
  }
});

test('G/preflight: exits zero when all required envs are set', () => {
  const r = runPreflight(allRequiredEnv());
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /preflight OK/);
});

test('G/preflight: never prints any env VALUE (only names)', () => {
  const r = runPreflight(allRequiredEnv());
  const out = r.stdout + r.stderr;
  assert.strictEqual(out.includes(SENTINEL), false, 'preflight must not echo a value');
  // Sanity: it DID mention the names, just not the values.
  for (const name of REQUIRED) assert.match(out, new RegExp(name));
});

// ===========================================================================
// /api/health — 200 { ok:true }, correct shape, no lead/PII fields
// ===========================================================================

const PII_FIELDS = [
  'name',
  'phone',
  'email',
  'address',
  'zip',
  'leads',
  'lead',
  'won',
  'assignedRep',
  'notesLog',
  'REP_CREDENTIALS',
  'BOARD_PASSWORD',
  'SESSION_SECRET',
  'LEDGER_SECRET',
];

test('G/health: returns 200 { ok:true } with the checks shape', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.strictEqual(r.status, 200);
  const d = await r.json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(typeof d.ts, 'string');
  assert.strictEqual(typeof d.checks, 'object');
  assert.ok(['up', 'down'].includes(d.checks.store));
  assert.ok(['valid', 'broken', 'unknown'].includes(d.checks.ledger));
});

test('G/health: leaks no lead data, PII, or secret fields', async () => {
  const r = await fetch(`${base}/api/health`);
  const raw = await r.text();
  const d = JSON.parse(raw);
  // Body is exactly the three expected top-level keys — nothing else.
  assert.deepStrictEqual(Object.keys(d).sort(), ['checks', 'ok', 'ts']);
  assert.deepStrictEqual(Object.keys(d.checks).sort(), ['ledger', 'store']);
  // Defense in depth: none of the PII/secret field NAMES appear in the body.
  for (const field of PII_FIELDS) {
    assert.strictEqual(
      raw.includes(`"${field}"`),
      false,
      `health body must not contain a ${field} field`
    );
  }
});

test('G/health: is GET-only (405 on POST), side-effect free', async () => {
  const r = await fetch(`${base}/api/health`, { method: 'POST' });
  assert.strictEqual(r.status, 405);
});

// ===========================================================================
// staged docs — no banned money phrasing, no secret-looking literals
// ===========================================================================

const DOCS = ['docs/RUNBOOK.md', 'docs/REP-QUICKSTART.md', 'docs/BOARD-ACCESS.md'];

// Mirror scripts/lint-copy.js MONEY_BANNED: the deal is 20% of PROFIT.
const MONEY_BANNED = [
  { re: /\b30\s*%/, why: 'thirty-percent overclaim' },
  { re: /%\s*of\s*(the\s*)?revenue/i, why: 'percent-of-revenue overclaim' },
  { re: /rev(enue)?[-\s]?share/i, why: 'revenue-share overclaim' },
  { re: /percentage\s+of\s+revenue/i, why: 'percentage-of-revenue overclaim' },
];

test('G/docs: staged enablement docs exist', () => {
  for (const rel of DOCS) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} exists`);
  }
});

test('G/docs: no banned money-term phrasing in staged docs', () => {
  for (const rel of DOCS) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { re, why } of MONEY_BANNED) {
        assert.strictEqual(re.test(line), false, `${rel}:${i + 1} [${why}] -> ${line.trim()}`);
      }
    });
    // Positive: the canonical wording is present.
    const text = lines.join('\n');
    assert.match(text, /20%\s*of\s*(the\s*)?profit/i, `${rel} names 20% of profit`);
  }
});

test('G/docs: no secret-looking literals in staged docs', () => {
  // High-entropy runs and known key prefixes — placeholders like
  // "<set in Vercel>" and env NAMES are fine; real-looking secrets are not.
  const SECRETY = [
    { re: /\b[A-Fa-f0-9]{32,}\b/, why: 'long hex token' },
    { re: /\b[A-Za-z0-9]{40,}\b/, why: 'long high-entropy token' },
    { re: /\b(sk|pk|rk|whsec|re)_[A-Za-z0-9]{12,}\b/, why: 'provider key literal' },
    { re: /Bearer\s+[A-Za-z0-9._-]{16,}/, why: 'inline bearer token' },
  ];
  for (const rel of DOCS) {
    const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const { re, why } of SECRETY) {
        assert.strictEqual(re.test(line), false, `${rel}:${i + 1} [${why}] -> ${line.trim()}`);
      }
    });
  }
});
