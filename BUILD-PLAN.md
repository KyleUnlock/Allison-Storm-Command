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

## Phase B — Compliance Spine ("Phase 5") — **DONE**

Every compliance gate fails safe (absence of consent/scrub/provider WITHHOLDS).
Evidence: `npm test` 46/46 green + `lint:copy` OK.

- **B1 DNC on export.** `api/export.js` (operator-gated CSV, like `api/board`) +
  `lib/export.js` (`toCsv`/`exportPhone`). A phone leaves ONLY when
  `dnc.isCallable(lead).callable`; unscrubbed/cold or no-provider numbers are
  redacted. Fail-safe test: *"B1 FAIL-SAFE: with NO DNC provider env set, ALL
  cold phones are withheld."*
- **B2 SB140 SMS consent + opt-out.** `lib/consent.js` (ledgered
  `consent:sms:<phone>` / `optout:sms:<phone>`, `isSmsCallable`) + `api/sms-optout.js`
  (STOP handler, one-directional). `index.html` carries the SB140 opt-in checkbox;
  `api/leads.js` captures consent without re-widening the sanitized public POST.
  Fail-safe test: *"B2 FAIL-SAFE: a number with NO consent record is NOT
  SMS-callable"* (+ opt-out stays opted-out).
- **B3 3-day right-to-cancel.** `lib/notices.js` (canonical
  `NOTICE_3DAY_CANCEL`) surfaced on `notice.html` (route `/notice`, linked from
  intake). Fail-safe test: *"B3 FAIL-SAFE: required compliance copy is present on
  its page (lint presence check)."*
- **B4 lint presence check.** `scripts/lint-copy.js` now also fails if the SB140
  SMS-consent marker is missing from `index.html` or the 3-day-cancel marker from
  `notice.html`; all existing deductible/HB-2102/storm/money-term checks retained.

## Phase D — Paid-Play Lead Sources (ad webhooks) — **DONE (ships dark)**

Maps external paid-ad leads into the EXISTING sanitized `createLead` path with
`source='ad'`, so they inherit scoring, routing, SLA, and DNC/consent gating. No
re-widening of the public POST. Both webhooks are signature-verified over the RAW
request body and **FAIL CLOSED** when their env secret is unset: a live probe
returns the designed 401/403 — **never 500, never a lead**. Kyle flips the env
when the ad accounts are granted.

- **D1 Meta Instant Form** — `api/meta-webhook.js`. POST verifies
  `X-Hub-Signature-256` (`sha256=<hex>` HMAC-SHA256 over raw body) with
  `META_APP_SECRET`; **unset secret → 401**. GET subscription handshake echoes
  `hub.challenge` only when `hub.mode=subscribe` and `hub.verify_token` matches
  `META_VERIFY_TOKEN`; **unset token → 403**. Maps `field_data` →
  `source='ad'`, `adSource='meta'`, campaign/form ids in `campaign`.
- **D2 Google LSA / CallRail** — `api/callrail-webhook.js`. Verifies HMAC-SHA256
  (base64 digest) over the raw body with `CALLRAIL_SIGNING_KEY`; **unset key →
  401**. Maps the call → `source='ad'`, `adSource='callrail'` (or `'lsa'` for
  Google Local Services). Caller number captured but a cold `ad` phone — **not
  callable until DNC-scrubbed**.
- **D3 source-ROI tagging** — `lib/leads.createLead` now persists `adSource` +
  `campaign` (source/campaign/form/ad ids + cost/click ids like `gclid`) on the
  lead for the later cost-per-lead / close-rate-by-source analytics phase.
  `api/board` + `board.html` surface `source · adSource`.
- **Shared verify** — `lib/webhook-verify.js` (`readRawBody`, `verifySignature`,
  constant-time `timingSafeEqual` over `node:crypto`), reused by both handlers.
  Both read the RAW body; `serve.local.js` passes it through for local/test runs.
- Evidence: `test/phased.test.js` — for BOTH webhooks: unset secret → fail
  closed / no lead; bad signature → fail closed / no lead; valid signature →
  sanitized `source='ad'` lead created, scored, DNC-withheld; plus the Meta GET
  challenge echo (only with the correct token). `npm test` green + `lint:copy` OK.

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
