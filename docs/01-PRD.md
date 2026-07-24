# 01 — Product Requirements

## 1. One-line
Once a month, turn "I have ₹X" into a ranked, explained, tax-aware Indian ETF buy plan that remembers
what you already own and learns (deterministically) from what worked.

## 2. Users
v1: single user (owner); **public signups disabled** at the Supabase Auth level (docs/09 §4).
Schema is multi-tenant from day 1 (`user_id` on every user-owned row, Supabase RLS) so
productizing later is a config change plus the gates in docs/09 §4 — not a schema migration.

## 3. User flows

### 3.1 Onboarding (once, editable)
Inputs: date of birth, risk appetite (conservative / moderate / aggressive — 5-question quiz maps to
one of the three), monthly default amount X (editable per run), existing holdings (optional import).

Derived (deterministic, docs/03 §1):
- Equity glide: `equity_pct = clamp(115 - age, 40, 90)` (moderate); ±10 for aggressive/conservative.
- Theme count N: conservative 1–2, moderate 2–4, aggressive 3–5.
- Core/satellite split of the equity sleeve: conservative 80/20, moderate 65/35, aggressive 50/50.
  Core = one broad-market ETF on the fixed core index (default Nifty 50 — docs/03 §1). Satellite =
  thematic picks. Rationale: thematic ETFs are volatile and low-liquidity; satellite sizing caps
  blast radius.

Profile edits never mutate an existing plan; they take effect from the next run. The plan screen
shows a "profile changed since this plan" notice with a Run-now shortcut (re-run semantics §3.5).

### 3.2 Monthly run (the core loop)
Trigger: pg_cron on the 1st trading day at **23:30 IST — after prices, NAV and TRI have all landed**
(schedule + preconditions: docs/10 §2), or "Run now" button.
Input: X (paise) + carry-in residual (docs/03 §4), current lots, last run's picks + their performance since.

Pipeline (each stage persisted, resumable; driver + state machine in docs/10 §3):
1. **Theme research (LLM, Sonnet + web search)** → candidate themes w/ macro rationale, citations.
   Shared per month across users (`theme_research` keyed by month — docs/05).
2. **Investability gate (deterministic)** → drop themes with no eligible Indian ETF (docs/03 §2).
3. **Theme ranking (deterministic score + feedback adjustment)** → top N, numbered, each with
   "why this rank / why over the next one" (narrative by Haiku, numbers from engine).
4. **ETF ranking per theme (deterministic)** → 1–5 per theme, numbered, scored, explained.
5. **Allocation** → whole units per ETF, ₹ per pick, residual carry (docs/03 §4).
6. **Plan card** → user reviews; marks "Bought" per line → creates lots. Nothing is assumed bought.
   Pre-filled price is the plan-date close, visually marked "estimated — replace with your actual
   execution price"; confirming requires touching the price field or explicitly ticking
   "use estimate" (cost basis drives every downstream tax number). Units are pre-filled but
   editable too — partial fills happen; both qty and price feed the lot as entered.

### 3.3 Portfolio & performance
- Holdings table: qty from the derived view; **avg cost, invested, current value, unrealized P&L
  and days-to-LTCG are computed by the engine's FIFO lot walk** (after partial sells, no SQL
  aggregate is correct — docs/05 holdings view comment), per lot and per holding.
- Charts (Recharts; series bases labeled per docs/08 §3):
  a. Each holding (price basis) vs its benchmark **TRI** vs up to 3 rival ETFs (NAV basis) on the
     same index — normalized to 100 at the **earliest open lot's buy date**, with per-lot buy markers.
  b. Portfolio value vs "what if all-in Nifty 50 (TRI)" counterfactual.
  c. Theme attribution: which theme contributed what P&L.
- Feedback badges on each holding: OUTPERFORM / INLINE / LAG (docs/03 §5) with the numbers that produced it.

### 3.4 Sell planner & tax report
- "What if I sell" per lot or holding: gross gain, STCG/LTCG classification, exemption usage,
  tax due, all charges, net proceeds (docs/04).
- FY tax report: realized gains by class, exemption ledger (₹1.25L equity LTCG; external usage
  from the FY-scoped input — docs/04 §2.1), carry-forward losses.

### 3.5 Re-run semantics ("Run now" vs the scheduled run)
- "Run now" in a month with an existing run in flight resumes it from its checkpoint.
- "Run now" over a `done` run requires an explicit "re-run (replaces plan)" confirmation and
  creates a **superseding run** (same `run_month`, `seq+1`; old run → status `superseded`,
  read-only history for its rankings). Lots already booked against the old plan remain and feed
  the new run's portfolio input.
- **No double-spending**: the confirmation dialog pre-fills the new run's `amount_paise` as
  `max(0, old amount − Σ consideration of lots already booked against the old run this month)`,
  editable, with an explicit "already deployed ₹Y against the superseded plan" line. If the user
  deployed MORE than the old amount (they spent into the carry), the excess is deducted from the
  carry-in shown for the new run — spendable stays correct in both branches. Carry-in is
  consumed exactly once, by the month's final non-superseded run.
- "Mark bought" **remains available on a superseded run's lines** (the user may have executed
  before re-running); those lots link to the superseded run. Marking bought there AFTER a
  superseding run exists shows a notice: "the newer plan's amount did not account for this
  purchase — adjust it if you haven't executed the new plan yet" (soft notice; no enforcement in v1).
- **"Run now" over a `failed` run** creates a fresh run (same `run_month`, `seq+1`) WITHOUT the
  supersede confirmation — a failed run produced no plan to replace; the failed run stays
  terminal for audit.

## 4. Screens (shadcn/ui; apply frontend-design skill; dark-friendly, data-dense)
1. Onboarding wizard (3 steps).
2. Dashboard: latest plan summary, portfolio tiles, next-run date, **job-failure / quarantine
   banner** (docs/10 §6).
3. Monthly Plan: ranked theme cards (1..N) → expand to ranked ETF rows (1..M) with score breakdown
   bars → allocation table (units × price = ₹, % of X) → residual note → "Mark bought" actions.
   Excluded-ETF list with reasons (gates G1–G7, incl. `stale_metrics`).
4. Portfolio: holdings table + lot drawer + CSV import (limits & dedup: docs/09 §6).
5. Performance: the three charts + feedback badges.
6. Taxes: sell planner + FY report.
7. Settings: profile, X default, per-user charge overrides (docs/05 `user_charges_overrides` —
   global config is never client-writable), FY exemption input, run history, manual TRI CSV
   upload (owner-admin), metrics review-queue paste-in (owner-admin, feeds admin-submit-metrics),
   and **force re-research this month** (owner-admin, counts against the spend cap — docs/09
   §2.1, docs/10 §7). All manual-data paths on this screen are owner-admin functions.

Rotation proposals (docs/03 §5) render on the Monthly Plan (screen 3) and on the affected
holding's row in Portfolio (screen 4).

**Disclaimers (explicit enumeration, not a vibe):**
- Screens 2, 3, **4** (holdings carry feedback badges, days-to-LTCG, and rotation advice), 5, 6 —
  every surface showing recommendations, badges, or sell suggestions — carry the investment
  disclaimer footer: "Educational analysis, not investment advice. Not SEBI-registered." The
  onboarding wizard's final summary step (derived glide path / split — screen 1) carries it too.
- Screen 6 and the FY report additionally carry a tax disclaimer: "Computed estimates, not tax
  advice; verify with a tax professional."
- Every exported/downloaded artifact (plan CSV, FY report) embeds the disclaimer as its first line
  (docs/09 §7).

### 4.1 Empty & error states
- First run: seeding + a few nights of ingestion must complete before the first plan (staleness
  gate would rightly block it). Dashboard shows "data warming up — first plan available ~<date>"
  computed from ingestion progress.
- Failed run: plan screen shows a human-readable card mapped from `fail_reason`
  (`stale_data`, `ingest_missing`, `stale_metrics`-driven empty plan, LLM-fallback notice), never
  a raw error string.
- Empty portfolio: CTA to import CSV or add a lot; feedback badges absent until one full month of
  held data exists.

## 5. Explanations format (hard requirement from owner)
Rankings are numbered lists. Each item: one-line thesis, 3 factor bullets **with the actual numbers**
(e.g., "TD 1y −0.38% vs peer −0.61%"), and one line "why above #k+1". The narrative model receives
ONLY the engine's computed factor table — it phrases, it does not decide (rendering rules docs/09 §8).

## 6. Acceptance criteria (v1 done when)
- A monthly run completes end-to-end on live data in **< 10 min wall clock** (no single stage >
  min(2.5 min, 60% of the pinned Edge Function limit — docs/10 §8)), and in < 60 s when the LLM
  stage is served from the monthly cache or fallback.
- LLM spend **< $0.50 month-to-date** (the docs/10 §6 alert threshold; hard global cap $2/month — docs/10 §7).
- Allocation always satisfies: Σ(units×price) ≤ X_spendable, and residual < min price among picks
  still under their weight cap OR all picks are cap-bound (reported as "cap-bound residual") —
  docs/03 §4.
- Tax engine reproduces the docs/04 §4.0-fixture worked examples E1–E5 to the paisa.
- Deleting/adding a lot recomputes holdings, feedback badges, and sell planner correctly; oversell
  attempts (UI or CSV) are rejected with the offending row identified.
- Charts render vs TRI (not price index), label each series' basis (price/NAV/TRI) and data
  source + as-of date.
