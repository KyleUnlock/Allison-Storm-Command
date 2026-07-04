# Board & Report Access — Allison Storm Command

Prep sheet for the operator / manager who needs the lead board and the
performance report. This is a **staged draft for review** — not sent. It
contains **no password value**; the real board password is set by Kyle in Vercel
and shared separately.

---

## What you get access to

Two operator surfaces, both **read-first** dashboards over the same lead data:

| Path | What it shows |
|------|---------------|
| **`/board`** | The full lead table — every lead with its stage, source, assigned rep, callable/consent status, SLA state, notes, and Won dollar + UnlockAI-fee totals. There's also a kanban view at `/crm` (drag-drop / touch-select to move stages). |
| **`/report`** | The performance report — funnel counts and conversion, source/campaign ROI, per-rep leaderboard, SLA breach rate and latency, the UnlockAI fee roll-up (**20% of profit**), and a ledger-integrity badge. Pure aggregation — it reads, it never changes leads. |

---

## How to reach them

1. Go to **`/board`** (or `/crm`, or `/report`).
2. When prompted, enter the **board password** — `<board password — set by
   Kyle>`. The same password gates all three operator surfaces.
3. That's it. A field-rep login does **not** open these — the operator password
   is separate and required.

---

## What it does and doesn't do

- **Read-focused.** `/report` is view-only aggregation. `/board` and `/crm` show
  everything and let an operator move a lead's stage or add a note; they do not
  expose rep passcodes or any secret.
- **Fee is always 20% of profit** (collected minus direct costs) — never a cut
  of revenue. The report's fee total is just that math summed across Won leads.
- **Ledger badge:** if the report shows the ledger as anything other than
  valid, don't act on the billing numbers — flag it to Kyle.

## Keep it safe

- The board password is the operator key to every lead's contact info. Don't
  share it, don't paste it into chat, and never write the real value into any
  doc (including this one).
