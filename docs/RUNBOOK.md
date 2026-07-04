# Operator Runbook — Allison Storm Command

Operator/integrator reference for running, launching, and maintaining the
Allison Roofing storm-restoration lead-gen app. This is a **staged** document —
review before circulating. It contains **no credential values**; every secret is
shown as a placeholder and is set in Vercel, never committed.

The app is static HTML pages + Vercel serverless functions (`api/*.js`) + an
Upstash/Vercel KV store, framework-free. It runs on Node built-ins only.

---

## 1. Environment variables

Set these in the Vercel project env (Production/Preview). Local dev and tests run
**without** them (KV falls back to in-memory; secrets fall back to local test
defaults). Names are authoritative — see `.env.example`. **Never commit values.**

### Auth / session
| Name | What it does | Where set |
|------|--------------|-----------|
| `SESSION_SECRET` | HMAC key signing the operator/rep session cookies. **Required.** | Vercel env `<set in Vercel>` |
| `LEDGER_SECRET` | HMAC key folded into every hash-chained ledger entry; rotating it invalidates chain verification, so treat as permanent post-launch. **Required.** | Vercel env `<set in Vercel>` |
| `BOARD_PASSWORD` | Single operator gate for `/board`, `/crm`, `/report`, and `api/board`/`api/report`. A rep session does **not** satisfy it. **Required.** | Vercel env `<board password — set by Kyle>` |
| `REP_CREDENTIALS` | Field-rep login map `"name:passcode,name2:passcode2"`. Unset ⇒ no rep can sign in. | Vercel env `<set in Vercel>` |

### KV store
| Name | What it does | Where set |
|------|--------------|-----------|
| `KV_REST_API_URL` | Upstash/Vercel KV REST endpoint (NOT `UPSTASH_*`). **Required** in prod. | Vercel/Upstash integration `<set in Vercel>` |
| `KV_REST_API_TOKEN` | KV REST bearer token. **Required** in prod. | Vercel/Upstash integration `<set in Vercel>` |

Unset ⇒ the store uses an in-memory Map (data is **not** durable — fine for local
dev, never for prod).

### Webhooks — Meta + CallRail (ship dark)
| Name | What it does | Where set |
|------|--------------|-----------|
| `META_APP_SECRET` | Signs `X-Hub-Signature-256` on Meta Instant Form posts. Unset ⇒ the webhook **fails closed** (401/403, no lead created). | Vercel env `<set in Vercel>` |
| `META_VERIFY_TOKEN` | Gates the Meta GET subscription handshake. | Vercel env `<set in Vercel>` |
| `CALLRAIL_SIGNING_KEY` | HMAC-SHA256 (base64) body-signature key for Google LSA / CallRail posts. Unset ⇒ fails closed. | Vercel env `<set in Vercel>` |

Leave these unset until the ad accounts are actually granted — the webhooks
create **no** lead while dark, which is the correct default.

### Scheduled import
| Name | What it does | Where set |
|------|--------------|-----------|
| `CRON_SECRET` | Gates `api/storm-import`. Unset ⇒ the import endpoint stays closed. | Vercel env + Cron config `<set in Vercel>` |

### DNC provider
| Name | What it does | Where set |
|------|--------------|-----------|
| `DNC_PROVIDER` | Do-Not-Call scrub provider name. Unset ⇒ cold storm/ad leads are **withheld** (correct fail-safe, not a bug). | Vercel env `<set in Vercel>` |
| `DNC_API_KEY` | DNC provider API key; pairs with `DNC_PROVIDER`. | Vercel env `<set in Vercel>` |

### Internal notifications (fail-safe)
| Name | What it does | Where set |
|------|--------------|-----------|
| `RESEND_API_KEY` | Transport for **internal** operator alerts only (new-lead + SLA-breach). Unset ⇒ notify no-ops; nothing is ever sent to homeowners. | Vercel env `<set in Vercel>` |
| `NOTIFY_TO` | Internal recipient(s) for those operator alerts. | Vercel env `<set in Vercel>` |

### Routing / SLA / commission
| Name | What it does | Where set |
|------|--------------|-----------|
| `REP_TERRITORIES` | Optional territory map `"name:zipPrefix,..."`, matched before round-robin over `REP_CREDENTIALS`. Unset ⇒ pure round-robin. | Vercel env `<set in Vercel>` |
| `SLA_FIRST_TOUCH_MINUTES` | First-touch SLA threshold in minutes. Unset ⇒ default 60. | Vercel env `<set in Vercel>` |
| `COMMISSION_RATE` | Locked at `0.20` — the UnlockAI fee is 20% of profit (collected minus direct costs). Do not change. | `.env.example` / code default |

---

## 2. Preflight (run before every go-live)

```bash
npm run preflight
```

Asserts every **required** fence var is present, **warns** (non-fatal) on the
optional/ship-dark ones, prints the ledger-integrity badge, and exits non-zero
if a required var is missing. It **never prints a value** — only the name and a
set/missing verdict. Green preflight is a launch precondition, not a substitute
for the manual fence checks below.

---

## 3. Health check

`GET /health` (rewrites to `api/health`) returns a public, side-effect-free
probe:

```json
{ "ok": true, "ts": "<iso>", "checks": { "store": "up|down", "ledger": "valid|broken|unknown" } }
```

No secrets, no lead data, no PII. Use it for uptime monitoring and post-deploy
smoke. `ledger: "broken"` ⇒ jump to §7 (ledger-integrity).

---

## 4. Run locally + smoke

```bash
node serve.local.js            # http://localhost:4010 (in-memory KV, no env needed)
npm test                       # node:test suites + lint:copy (offline)
npm run lint:copy              # copy-compliance gate (must exit 0)

# key-endpoint smoke against the running dev server (CREATES 2 test leads).
# Uses the in-memory dev defaults; set BOARD_PASSWORD / REP_CREDENTIALS in the
# shell only if you want to exercise them against non-default values.
bash smoke.sh
```

`smoke.sh` asserts the public intake, storm-status, board gate, and rep-auth
gates. Run it only against a dev/in-memory server, never prod.

---

## 5. Deploy handoff (READ THIS)

**Deploy is Mac-side, performed by one integrator.** This app ships to its
`claude/...` branch only. The `Allison-Storm-Command` repo's `main` branch
**auto-deploys the LIVE Allison marketing site** — so this lead-gen app must
**never** be merged to `main`. Kyle owns the merge/deploy decision.

The app's own Vercel project deploy (once the integrator runs it) is:

```bash
vercel --prod --scope unlock-ai-e2fcd955
```

Vercel project: `prj_35bMjTBPHBA7npGy0D3RqePWIzwl`.

Before any deploy: `npm test` green, `npm run lint:copy` exit 0, `npm run
preflight` green against the target env.

---

## 6. KV setup

1. Provision an Upstash Redis (or Vercel KV) database.
2. Copy its **REST** URL + token into `KV_REST_API_URL` / `KV_REST_API_TOKEN`
   (the REST pair, NOT the `UPSTASH_*` names).
3. Redeploy so the functions pick up the env. Confirm via `/health` →
   `checks.store: "up"`.

Data model: leads are stored per-id; the ledger is a single list under key
`ledger` (oldest → newest). No migration step is needed on first launch.

---

## 7. Ledger-integrity check

Every billing-relevant event is appended to a **hash-chained** ledger
(`lib/ledger.js`): each entry folds in the prior entry's hash plus
`LEDGER_SECRET`, so altering any past entry breaks the chain from that point on.

- Fast check: `GET /health` → `checks.ledger`.
- Deep check in a Node REPL / one-off with prod env loaded:

  ```js
  const store = require('./lib/store');
  const ledger = require('./lib/ledger');
  ledger.verifyChain(await store.listRange('ledger'));
  // → { valid: true, brokenAt: -1 }  (intact)
  // → { valid: false, brokenAt: N }  (first tampered/broken entry index)
  ```

- `valid: false` ⇒ **stop billing decisions**, do not "fix" data, escalate to
  Kyle. A broken chain means the store was tampered with or `LEDGER_SECRET`
  changed. Never rotate `LEDGER_SECRET` after launch — it invalidates all prior
  verification.

---

## 8. Webhook secret rotation

Meta / CallRail webhooks fail closed when their secrets are unset, so rotation is
safe to do live:

1. Generate the new secret in the provider console.
2. Update the matching env (`META_APP_SECRET` / `META_VERIFY_TOKEN` /
   `CALLRAIL_SIGNING_KEY`) in Vercel.
3. Redeploy (or promote) so functions read the new value.
4. Update the provider's configured signing secret to match.
5. Verify a test post is accepted; a mismatch returns 401/403 and creates no
   lead (fail-closed).

Never loosen or bypass signature verification to "unblock" a webhook — a failing
signature is the gate working.

---

## 9. DNC provider wiring

A phone is callable **only** after a real provider scrub with provenance. With
`DNC_PROVIDER` unset, cold storm/ad leads are withheld — the intended default.

To enable: set `DNC_PROVIDER` + `DNC_API_KEY`, redeploy, and confirm scrubbed
leads surface as callable on the board. DNC state changes are ledgered and
one-directional-safe: a number marked DNC cannot flip back to callable without a
fresh scrub with provenance. Do not hand-edit callability.

---

## 10. Incident / rollback

- **Bad deploy:** roll back to the previous deployment in the Vercel dashboard
  (instant promote of the prior build). No data migration is involved — KV is
  unchanged by a code rollback.
- **Suspected data tamper:** run the §7 ledger check; if broken, freeze billing
  and escalate.
- **Webhook flood / abuse:** the webhooks already fail closed on bad signatures;
  if needed, unset the provider secret to take that intake dark, redeploy.
- **Store outage:** `/health` shows `store: "down"`. Reads/writes fail loudly;
  do not switch to in-memory in prod (data loss). Restore KV, redeploy.
- Escalation owner for launch decisions: Kyle. External sends and any gate
  change stay behind Kyle's approval.
