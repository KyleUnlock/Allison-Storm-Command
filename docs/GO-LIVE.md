# GO-LIVE — Allison Storm Command

Final path from "deployed" to "a live funnel that keeps its leads."
Verified live 2026-07-19 against `https://allison-storm-command.vercel.app`.

## Where it stands (verified 2026-07-19)

| Thing | State |
|-------|-------|
| Code | `main` HEAD `10405c3` — 136/136 tests green, `lint:copy` clean, smoke 8/8 |
| Prod deploy | **Already live.** Both Vercel projects serve `10405c3` (see "Two projects" below) |
| Deployment Protection | **OFF** — public funnel reachable (`/`, `/api/storm-status` → 200) |
| Operator gate | Holds — `/api/board` → 401 `operator auth required` (fails closed) |
| Homeowner intake `/` | Renders fully: Houston copy, SB140 SMS-consent checkbox, 3-day-cancel link, HB-2102 disclaimer |
| **KV persistence** | ❌ **NOT WIRED** — `/health` → `{"backend":"memory","degraded":true}` |

### ⚠️ The one blocker: KV is not wired → leads are being lost

`/health` reports `backend: memory`. On Vercel every serverless invocation gets
its **own** ephemeral memory, so a homeowner who submits the form sees the
friendly "Thanks! A local specialist will reach out" message and a `201` — but
the lead is written to a Map that dies with that invocation. **No lead reaches
`/board`, `/crm`, or any rep.** If this URL is being shared or advertised,
real leads are vanishing right now.

Everything else needed for go-live is done. Wiring KV is the finish line.

## The go-live checklist (all Kyle-only — Vercel dashboard)

Do these on the **canonical** project (see below), then redeploy so the env binds.

### 1. Provision KV and wire it (unblocks lead capture — REQUIRED)

1. Vercel dashboard → the `allison-storm-command` project → **Storage** → create/attach
   an **Upstash KV** (or Vercel KV) store.
2. Confirm these land in the project's **Production** env (Vercel injects them on attach):
   - `KV_REST_API_URL`
   - `KV_REST_API_TOKEN`
3. Redeploy (attaching a store does not rebind a running deployment). Then verify:
   `/health` must read `{"backend":"kv","degraded":false}` — **not** `memory`.

### 2. Set the required secrets (REQUIRED — auth fails closed without them)

In Production env:
- `SESSION_SECRET` — operator/rep session HMAC. Generate a fresh 32-byte value:
  `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `LEDGER_SECRET` — hash-chain secret for attribution integrity. Generate the same way.
  ⚠️ Set this **once** and never rotate it after the first Won bills — rotating
  breaks `verifyChain()` on all prior entries.
- `BOARD_PASSWORD` — operator gate for `/board`, `/crm`, `/report`. Kyle picks the value.
- `REP_CREDENTIALS` — rep login map `user:pass[,user2:pass2]` so Terrell can sign in
  at `/rep`. Never commit the value; deliver Terrell's passcode out-of-band.

> Never put any of these values in a git-tracked file. Paste them straight into
> the Vercel dashboard.

### 3. Confirm live after redeploy

- `/health` → `backend:"kv"`, `degraded:false`
- `/` → intake renders (already true)
- Submit one real test lead → it appears on `/board` (operator login) → then delete it
- `/api/board` unauthenticated → still 401

### Ship-dark vars (leave UNSET until each is actually ready — they fail closed)

`DNC_PROVIDER` / `DNC_API_KEY` (unset ⇒ cold leads correctly withheld),
`CRON_SECRET` (gates `/api/storm-import`), `STORM_LIVE` (flip to `1` only after
verifying the NWS feed per RUNBOOK §11), `META_APP_SECRET` / `META_VERIFY_TOKEN`,
`CALLRAIL_SIGNING_KEY`, `RESEND_API_KEY` / `NOTIFY_TO`. Every one of these is
designed to fail closed when unset — a live probe returns 401/403, never a lead.

## Two projects deploy this repo — pick ONE canonical

Both of these auto-build from `KyleUnlock/Allison-Storm-Command` `main` (both on
SHA `10405c3` as of 2026-07-19):

| Project | ID | Live URL | Notes |
|---------|-----|----------|-------|
| **`allison-storm-command`** | `prj_Bvt4t2P8HwE53z0YFOiejJzOVcvf` | `allison-storm-command.vercel.app` | client-facing name; **recommended canonical** |
| `allison-roofing-leadgen` | `prj_35bMjTBPHBA7npGy0D3RqePWIzwl` | `allison-roofing-leadgen.vercel.app` | the id in the old README; a second live copy |

Two live copies of the same funnel = two separate KV stores and two lead books.
**Recommendation:** wire KV + secrets on `allison-storm-command` only, point
Allison/Terrell at that URL, and pause the GitHub auto-deploy on
`allison-roofing-leadgen` (or delete it) so a stray lead never lands in an
orphan store. Kyle decides which is canonical; this doc assumes
`allison-storm-command`.

## Fences (unchanged — carry into go-live)

- 20% of PROFIT, never revenue, never 30% (`lint:copy` gates it).
- TX HB 2102 — never market or absorb a deductible.
- Storm copy: "hail reported near [ZIP] per NWS" only; never a per-home strike claim.
- Cold leads stay withheld until DNC-scrubbed with provenance.
- No sends to Terrell/Chance/homeowners without Kyle's go.
