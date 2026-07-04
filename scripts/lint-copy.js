'use strict';

/**
 * scripts/lint-copy.js — copy compliance gate (`npm run lint:copy`).
 *
 * Greps the shipped HTML pages + app JS (lib/, api/) for banned language and
 * exits non-zero on any hit. Three families are banned:
 *   1. Deductible marketing/absorption (TX HB 2102): the word "deductible" and
 *      its "pay/waive/absorb your deductible" variants must never appear.
 *   2. Per-home storm overclaims like "your roof was hit" — storm copy must use
 *      the NWS phrasing ("hail reported near [ZIP] per NWS") instead.
 *   3. Money-term overclaims: the deal is 20% of PROFIT, so "30%", any
 *      "% of revenue", "revenue share"/"rev share", or "percentage of revenue"
 *      wording is banned — it can never silently reappear.
 *
 * Docs (*.md), tests, and this script are excluded from the scan. The money-
 * term patterns additionally exempt lib/deal-terms.js (the single canonical
 * source, whose DEAL_TERM_LONG disclaimer legitimately names the banned terms)
 * and .env.example.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Banned regexes (case-insensitive). Keep the patterns here as strings so the
// linter does not flag itself when it scans app files (it never scans /scripts).
const BANNED = [
  { re: /deductible/i, why: 'deductible language (TX HB 2102)' },
  { re: /roof was hit/i, why: 'per-home storm overclaim' },
  { re: /roof got hit/i, why: 'per-home storm overclaim' },
  { re: /your (home|house|roof) was (hit|damaged|struck)/i, why: 'per-home storm overclaim' },
  { re: /guaranteed approval/i, why: 'insurance overclaim' },
];

// Money-term overclaims. The deal is 20% of PROFIT — never 30%, never a cut of
// revenue. These run on every scanned file EXCEPT the exempt list below, whose
// canonical definitions/disclaimers are allowed to name the banned wording.
const MONEY_BANNED = [
  { re: /\b30\s*%/, why: 'thirty-percent overclaim (deal is 20% of profit)' },
  { re: /%\s*of\s*(the\s*)?revenue/i, why: 'percent-of-revenue overclaim (fee is on profit)' },
  { re: /rev(enue)?[-\s]?share/i, why: 'revenue-share overclaim (fee is on profit)' },
  { re: /percentage\s+of\s+revenue/i, why: 'percentage-of-revenue overclaim (fee is on profit)' },
];

// Files exempt from the MONEY_BANNED patterns only (matched by basename).
const MONEY_EXEMPT = new Set(['deal-terms.js', '.env.example']);

const SCAN_DIRS = ['', 'lib', 'api', 'public'];
const SCAN_EXT = new Set(['.html', '.js']);
const SKIP = new Set(['node_modules', 'scripts', 'test', '.git', '.vercel']);

function collect(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    if (SKIP.has(name)) continue;
    const full = path.join(abs, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) continue; // only scan the listed dirs, one level
    if (SCAN_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

let hits = 0;
const files = new Set();
for (const d of SCAN_DIRS) collect(d).forEach((f) => files.add(f));

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const moneyExempt = MONEY_EXEMPT.has(path.basename(file));
  const patterns = moneyExempt ? BANNED : BANNED.concat(MONEY_BANNED);
  lines.forEach((line, i) => {
    for (const { re, why } of patterns) {
      if (re.test(line)) {
        hits += 1;
        console.error(
          `BANNED COPY [${why}] ${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`
        );
      }
    }
  });
}

if (hits > 0) {
  console.error(`\nlint:copy FAILED — ${hits} banned phrase(s) found.`);
  process.exit(1);
}
console.log('lint:copy OK — no banned deductible/storm/money-term phrases found.');
