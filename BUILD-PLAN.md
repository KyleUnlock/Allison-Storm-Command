# Build Plan — Allison Storm Command

## Status

| Phase | Scope | Status |
|-------|-------|--------|
| **Core** | Intake, rep console, board, CRM kanban, billing (20% profit), strict hash-chained attribution, 90-day clamp, DNC fail-safe, storm/NWS copy compliance, KV store, tests + copy-lint | **DONE** |
| A | Inbound webhooks (lead sources, form providers) | TODO |
| B | Notifications (Resend email / SMS on new lead + stage change) | TODO |
| C | Analytics + reporting (funnel, cost-per-lead, rep leaderboard) | TODO |
| D | Live DNC provider integration (replace stub `lib/dnc` scrub with real API) | TODO |
| E | Live NWS/SPC feed (replace `lib/storm` stub with real hail-report source) | TODO |
| F | Scheduled storm imports via cron (`CRON_SECRET` gate already present) | TODO |
| G | Contracts / e-sign + payment reconciliation feeding the ledger | TODO |

> The lettered rows above (A–G) are the app's own feature phases. They are
> **separate** from the goal-file "Phase A — Truth & Consistency" tracked below,
> which is about money-term single-sourcing across the whole lead-gen effort.

## Phase A — Truth & Consistency (in-repo) — **DONE**

Hardened the repo against the money-term drift that plagued the sibling
marketing sites. The deal term is now single-sourced and the copy-lint actively
catches any revenue-share / 30% / percent-of-revenue overclaim so it can never
silently reappear.

- `lib/deal-terms.js` is the ONE canonical source for the wording. It imports
  `COMMISSION_RATE` (0.20) from `lib/leads.js` (no second source of truth) and
  exports `DEAL_TERM_SHORT = "20% of profit"`, `DEAL_TERM_LONG`, and a
  `formatFee(collected, directCosts)` helper (canonical `9000 − 5000 → "$800"`).
- `scripts/lint-copy.js` now also fails on money-term overclaims — `\b30\s*%`,
  `% of revenue`, `revenue-share`/`rev share`, `percentage of revenue` — across
  `*.html`, `lib/`, `api/`. `lib/deal-terms.js` (canonical disclaimer) and
  `.env.example` are the only exemptions; `test/`, `docs/`, `node_modules`,
  `scripts/` stay excluded. Trips print file+line.
- Copy swept: operator surface now reads "Fees (20% of profit)"; no page/handler
  says "30%", "revenue share", or "% of revenue". `test/dealterms.test.js` locks
  the `$800` figure, the `DEAL_TERM_SHORT` wording, and the lint patterns.

> **A1/A2 remain OUT OF THIS REPO.** The separate marketing sites
> (`allison-roofing-offering`, `allison-roofing-demo`, and the
> `allison-storm-command` marketing site) are separate Vercel projects whose
> source is Mac-scratch / currently unavailable — they are NOT in this repo.
> They are tracked in
> `_Coord/goals/allison-leadgen-COMPLETE-STRUCTURE-GOAL.md` Phase A and remain
> pending there.

## Core design notes

- **KV schema keys** (`lib/store.js`, 5 primitives: get/set/del/listPush/listRange):
  - `lead:<id>` → lead JSON object
  - `leads:index` → list of lead IDs (append-only)
  - `ledger` → list of hash-chained event entries
- **Ledger hash format** (`lib/ledger.js`): each entry is
  `{ prevHash, payload, hash }` where
  `hash = sha256( prevHash + LEDGER_SECRET + canonicalJSON(payload) )`.
  Genesis prevHash = 64 zeros. `verifyChain()` recomputes every link and
  returns `{ valid, brokenAt }`.
- **Billing anchor**: `deliveredAt` (set at lead creation) is the 90-day window
  start; `windowEnd = deliveredAt + 90d`. The Won sign date is clamped to
  `[deliveredAt, serverNow]` before the window test.
- **Auth**: rep `alr_rep` = `base64url(payload).hmacSHA256(payload, SESSION_SECRET)`.

## Fences (carry into every phase)

- Never market or absorb an insurance deductible (TX HB 2102).
- Storm claims use NWS ZIP-scoped phrasing only; never a per-home strike claim.
- Cold leads stay withheld until scrubbed with provenance.
- Gate logic (attribution / billing / DNC) is only ever hardened, never loosened.
