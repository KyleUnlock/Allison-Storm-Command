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
