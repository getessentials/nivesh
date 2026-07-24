# 12 — Owner Guide (how it works, what to do and when)

Plain-language companion to docs/01–11 — those are the technical spec; this is "what do I actually
click, and when." Written 2026-07-24 after first real deploy to project `rsczpeuhyyxtrbrujrze`
(Supabase) / `nivesh-silk.vercel.app` (Vercel).

## 1. What this app does, in one paragraph

Once a month you tell it an amount (₹X). It looks at Indian market/policy conditions, picks 1–5
wealth-creation themes (defence, manufacturing, IT, gold, etc.), picks the best 1–5 ETFs per theme
by hard numbers (tracking quality, cost, liquidity — never by "how much it went up"), splits your ₹X
across those picks in whole units, and explains every number. An LLM only ever proposes theme
*ideas* with a rationale — it never touches a ranking, a rupee figure, or a tax number. Every ETF
must clear seven deterministic eligibility gates before it can even be considered.

## 2. Architecture at a glance

```
Browser (React) ──JWT──> Supabase Edge Functions ──> Postgres (RLS-scoped)
                              │
                              ├─ ingest-nav / ingest-prices / ingest-tri  (daily, cron)
                              ├─ refresh-metrics                          (monthly, cron)
                              ├─ monthly-run → 7 chained stage-* functions (monthly, cron + "Run now")
                              └─ admin-* functions                        (manual, you only)
```

No separate backend server — every piece of logic lives in a Supabase Edge Function (Deno/TS),
scheduled by `pg_cron` or triggered by the browser/you. The LLM (Anthropic) is called ONLY from
Edge Functions, never the browser.

## 3. How a monthly plan actually gets built (the 7-stage pipeline)

Triggered automatically on the month's first trading day (23:30 IST), or manually via "Run now."
Each stage is a separate Edge Function invocation — they chain to each other directly for speed,
with `run-driver` (every 10 min) as the backstop that retries/advances anything stuck.

1. **research** — Sonnet + web search proposes up to 10 theme candidates with a macro rationale.
   Zod-validated against the seeded theme list; on failure, falls back to a flat neutral score for
   every theme (the pipeline never blocks on the LLM).
2. **gate** — every ETF in the universe is checked against 7 hard rules: AUM, listed ≥12 months,
   liquidity (ADTV), tracking error, expense ratio, premium/discount to NAV, and metrics freshness.
   Fail any one → excluded, with the reason shown on the plan.
3. **theme-rank** — surviving themes scored 0–100 on policy tailwind (the LLM's only input, capped
   at 25% of the score), momentum, trend, breadth, and portfolio diversification. Top N selected
   based on your risk appetite (conservative 1–2, moderate 2–4, aggressive 3–5).
4. **etf-rank** — within each selected theme, surviving ETFs scored on tracking quality, liquidity,
   cost, scale, and peer-relative returns. Ranked list capped at 5 per theme.
5. **allocate** — your ₹X splits into core (broad market) / satellite (your themes) / non-equity
   (gold or debt) sleeves by age+risk, then down to individual ETFs and whole units, with any
   leftover paise reported honestly as "residual — carries to next month."
6. **narrate** — Haiku writes the plain-English "why #1 over #2" explanations from the factor
   tables computed above (again, LLM never touches the numbers, only prose).
7. **finalize** — a defensive check that total allocation never exceeds your amount, then marks
   the run done.

If a stage can't get the market data it needs (see §5), it waits and retries hourly until noon IST
the *next* day, then fails honestly with `ingest_missing` rather than guessing.

## 4. Tax & charges (separate from the recommendation engine)

Every sell you log gets FIFO-matched against your buy lots, classified STCG/LTCG per the current
`tax_config` (effective-dated, since rules changed in 2023/2024/2025 and will again), and run
through the full charges stack (brokerage, STT, stamp duty, GST, etc.) — all in integer paise, no
floating-point money math anywhere past the one rupee→paise conversion point.

## 5. What data has to exist before a plan can be built

| Data | Source | How it lands |
|---|---|---|
| ETF prices | Yahoo Finance / NSE bhavcopy fallback | automatic, daily 18:30 IST |
| ETF NAVs | AMFI bulk file / mfapi.in fallback | automatic, daily 22:30 IST |
| Index TRI (benchmark) | niftyindices.com | **currently broken** (site unreachable) — manual CSV upload, Settings page |
| AUM / TER / tracking error | no free API exists anywhere | **always manual** — Settings page form, monthly |
| ADTV / premium-discount | computed from the two rows above | automatic, no action needed |

A plan needs ALL FIVE for at least one theme's worth of ETFs before it can recommend anything.

## 6. One-time setup (owner)

Already done as of 2026-07-24: Supabase project, all migrations, all Edge Functions deployed, all
secrets set, Vercel project + deploy, cron schedule live. Full checklist: docs/11.
Remaining: disable public signups (Supabase Dashboard → Auth → Settings) — do this before sharing
the URL with anyone else, even accidentally.

## 7. Recurring owner tasks

| Task | How often | Deadline / when | Where | Notes |
|---|---|---|---|---|
| Fill AUM/TER/tracking-error form | Monthly, after the last Saturday of each month | Best done before the 1st trading day of the FOLLOWING month, 23:30 IST — that's when the next scheduled run reads it. Hard outer limit: within 45 days of being queued, or `stale_metrics` re-gates that ETF out even if you eventually fill it | Settings → "Metrics review queue" | `refresh-metrics` auto-queues every active ETF that Saturday 10:00 IST; the form only shows rows waiting on you |
| Upload TRI CSV | As needed, while niftyindices stays unreachable | **Hard deadline: 12:00 IST the day AFTER that month's 1st trading day** — past this, `stage-research` fails the whole run outright with `ingest_missing`, no retry | Settings → "TRI CSV upload" | Export the historical-data CSV from niftyindices.com per index, upload one file per index. Stop doing this once `ingest-tri` starts succeeding again (check `job_runs`) |
| Re-seed NSE trading holidays | Once a year, January | Before Jan 1 of the new year — the "1st trading day" calculation for January's run depends on it | Direct SQL / new migration (no UI yet) | `nse_holidays` table; docs/10 §1 |
| Check dashboard banner / health-check email | Whenever, or rely on the daily 10:30 IST alert email | Same day as the alert, ideally — it's flagging something already broken | Dashboard screen | Flags any job failure or unresolved quarantine in the last 7 days |
| Review `ingest_quarantine` | As it comes up | Within 3 trading days of the row appearing — past that, the affected ETF's price/NAV is stale enough to trip the OPS-1 staleness gate on its own | No UI yet (`admin-resolve-quarantine` not built) — direct SQL for now | Rows are ingested data that failed a sanity gate (value ≤0, future date, >20% single-day jump) |
| Click "Run now" or wait for auto-run | Monthly | No deadline — auto-fires the 1st trading day 23:30 IST if data's ready; "Run now" works any time after that | Monthly Plan page | Cron also retries days 2–10 in case the 1st was a holiday cluster |
| Log real buys/sells | As you actually trade | No system deadline, but do it same-day/soon — the tax engine and "stick with winners" feedback loop only see what you've logged, not your real broker state | Portfolio page (manual entry or CSV import) | The app never sees your real holdings otherwise |

## 8. First-time walkthrough (what you do right now)

1. Lock signups (§6, still open).
2. Sign in at the live URL — magic link.
3. Onboarding: age, risk appetite, monthly amount.
4. Wait a few days for real price/NAV data to accumulate (or check `job_runs` to confirm cron is
   actually firing).
5. Upload at least the NIFTY 50 TRI CSV (broad_core theme needs it; others can follow later).
6. Once the next last-Saturday cycle queues metrics, fill in AUM/TER for the ETFs you care about
   (you don't have to do all 34 at once — a plan only needs data for the themes that end up
   selected, but you won't know which those are until research runs).
7. Click "Run now."

Realistically: not same-day. The honest first real plan is probably ~1–4 weeks out, depending on
how fast the TRI/metrics manual steps get done.
