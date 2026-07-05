# Allison Storm Command

Storm-restoration lead-gen app for Allison Roofing (North Texas). Static HTML
pages + Vercel serverless functions (`api/*.js`) + Upstash/Vercel KV, framework-free.

This repo is the **CORE build** — the proven baseline. Unbuilt future phases
(webhooks, analytics, notifications, etc.) are tracked in `BUILD-PLAN.md`.

## Surfaces

| Path      | Who        | What                                                    |
|-----------|------------|---------------------------------------------------------|
| `/`       | public     | Homeowner intake + NWS hail lookup                      |
| `/rep`    | field reps | Per-rep console (passcode-gated, own leads only)        |
| `/board`  | operators  | Lead table (BOARD_PASSWORD)                             |
| `/crm`    | operators  | 9-stage kanban, drag-drop + touch `<select>` fallback   |
| `/lead?id=` | operator/own rep | Lead detail + billing/history                  |
| `/login`  | operators  | Operator sign-in                                        |

## Locked rules (encoded + tested)

- **Fee = 20% of PROFIT** (`COMMISSION_RATE = 0.20`), never revenue, never 30%.
  Profit = collected − direct costs. Known customer → $0. Out-of-window → $0.
- **Strict attribution**: a Won bills only against an original, server-stamped,
  **hash-chained** lead (`lib/ledger.js`); a broken chain is detectable.
- **90-day window clamped on BOTH ends**: the Won sign date is clamped to
  `[deliveredAt, serverNow]` so a future contractDate cannot dodge the fee.
- **Public POST is sanitized**: `source ∈ {web,ad,rep}` only (`storm` gated),
  `knownCustomer` forced false, self-attested DNC/consent ignored, strings scrubbed.
- **DNC fail-safe**: a phone is callable only after a provider scrub *with
  provenance*. No provider configured → cold storm/ad leads are **withheld**
  (correct behavior). DNC changes are ledgered and one-directional-safe.
- **Rep auth is server-scoped**: HMAC `alr_rep` cookie, `REP_CREDENTIALS` only
  (never `BOARD_PASSWORD`). A rep touches only their own leads; a rep session
  401s on `/api/board`.
- **Storm copy compliance**: "hail reported near [ZIP] per NWS" phrasing only;
  never a per-home strike claim; **never** any insurance-fee-absorption language
  (TX HB 2102). Enforced by `npm run lint:copy`.

## Run locally

```bash
node serve.local.js            # http://localhost:4010 (in-memory KV, no env needed)
npm test                       # node:test suites + lint:copy (offline)
npm run lint:copy              # copy-compliance gate
BOARD_PASSWORD=AllisonStorm-Cmd-2026 REP_CREDENTIALS="alice:secret123" bash smoke.sh
```

No network packages — everything runs on Node built-ins (`node:test`, `assert`,
global `fetch`). KV falls back to an in-memory Map when `KV_REST_API_URL` /
`KV_REST_API_TOKEN` are unset.

## Environment

See `.env.example`. Real passcodes/keys are provided at deploy time via Vercel
env and are **never** committed.

## Operations

Launch-hardening and enablement live under `docs/` (all **staged** for review —
nothing is sent):

- **[docs/RUNBOOK.md](docs/RUNBOOK.md)** — operator runbook: every env var,
  local run + smoke, deploy handoff, KV setup, webhook rotation, DNC wiring,
  incident/rollback, and the ledger-integrity procedure.
- **[docs/REP-QUICKSTART.md](docs/REP-QUICKSTART.md)** — Terrell-facing rep
  quickstart (login → claim → consent-gated outreach → notes → stages).
- **[docs/BOARD-ACCESS.md](docs/BOARD-ACCESS.md)** — Chance/operator `/board` +
  `/report` access prep.

```bash
npm run preflight              # assert required fence env NAMES before go-live (no values printed)
curl -s localhost:4010/health  # {ok:true, ts, checks:{store, ledger}} — public, no PII
```

`preflight` exits non-zero if a required var (`SESSION_SECRET`, `LEDGER_SECRET`,
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `BOARD_PASSWORD`) is missing; the
webhook/CRON/DNC/notify vars are ship-dark WARNs. `/health` is side-effect-free
and reports store reachability + ledger integrity.

## Deploy

```bash
vercel --prod --scope unlock-ai-e2fcd955
```

Vercel project: `prj_35bMjTBPHBA7npGy0D3RqePWIzwl`.
