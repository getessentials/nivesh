# 10 — Operations Runbook (calendar, cron catalog, pipeline driver, backups, alerting, limits)

Authoritative source for schedules and operational behavior. docs/02 §7 is a summary that defers
to this file.

## 1. Market calendar
- Table `nse_holidays (d date primary key, label text)` — seeded annually from the NSE published
  trading-holiday list (`VERIFY-AT-SEED` each January; owner task, 5 minutes).
- **Trading day** = Mon–Fri and `d not in nse_holidays`.
- **First trading day of month** = the smallest trading day with `d >= date_trunc('month', today)`.
- **Staleness arithmetic** (the OPS-1 gate): latest `etf_prices.d` / `etf_navs.d` for active ETFs
  must be within the last **3 trading days** counted via this calendar; otherwise `monthly-run`
  sets `status='failed'`, `fail_reason='stale_data'`.
- pg_cron cannot express "1st trading day"; see the daily-check pattern in §2.

## 2. Cron catalog (pg_cron stores UTC; IST = UTC+5:30)
| Job | Cron (UTC) | IST | Notes |
|---|---|---|---|
| ingest-prices | `0 13 * * 1-5` | 18:30 Mon–Fri | skip-if-holiday check inside function |
| ingest-nav | `0 17 * * *` | 22:30 daily | AMFI publishes late evening |
| ingest-tri | `30 17 * * *` | 23:00 daily | |
| monthly-run (scheduled) | `0 18 1-10 * *` | 23:30, days 1–10 | function exits no-op unless today = first trading day of month (1–10 covers holiday clusters; extra firings are free no-ops); also skips any user who already has a non-`failed` run for the month (an early "Run now" is never double-created or superseded by cron) |
| run-driver | `*/10 * * * *` | every 10 min | no-ops fast when no run is in flight |
| refresh-metrics | `30 4 * * 6` | Sat 10:00 | function exits no-op unless today = last Saturday of month |
| export-backup | *(not scheduled)* | — | **not built — owner decision, no backups (§5, docs/07 §13 item 15)** |
| health-check | `0 5 * * *` | 10:30 daily | alert email on failure streaks (§6) |
| retention sweep (job_runs only) | `0 2 * * 0` | Sun 07:30 | job_runs > 180d; backup pruning n/a since export-backup isn't built |

**Implementation (build-order step 6, 2026-07-24):** `supabase/migrations/20260724000001_pg_cron_schedule.sql`
schedules every row above except export-backup. Every job except the retention sweep calls a
`cron_invoke_edge_function(name)` SQL helper that looks up the cron secret from Supabase Vault and
the project URL from a Postgres GUC — **both require a one-time manual setup step per environment**
(documented at the top of that migration file) before the schedule can fire successfully; neither
value is ever committed to the migration itself (docs/09 §3). Two deploy-time verification items
(ops/security review, not code changes): (1) if the setup step is skipped or wrong, the resulting
failure is visible only in `cron.job_run_details`, never in `job_runs` — the Dashboard banner and
`health-check` both read `job_runs` exclusively, so check `cron.job_run_details` manually after
first applying this migration; (2) confirm `pg_net`'s own functions (`net.http_post` etc.) and
`vault.decrypted_secrets` aren't independently granted to `anon`/`authenticated` beyond Supabase's
own defaults — this migration doesn't touch those grants, it only restricts its own helper function.

**Monthly-run timing decision (resolves the OPS-5 contradiction):** the scheduled run fires at
**23:30 IST on the first trading day — after prices (18:30), NAV (22:30), and TRI (23:00) have all
landed** — not 19:00 as earlier drafts said (CLAUDE.md build-order step 6 updated to match).
**Ingest precondition (before stage 1)** — data for the RUN DATE (the first-trading-day date,
derived from the trading calendar — not "today", since waits cross midnight) must be present.
ALL THREE legs are defined on **data presence, never job status** (a job can log `ok=true` while
the source was late — e.g. AMFI still serving yesterday's NAVAll at 22:30; zero-new-rows is a
job success, recovery is this re-check's job):
- prices: run-date `etf_prices` rows exist for every active ETF (or ≥90% of them; threshold
  pinned at seed);
- NAV: run-date `etf_navs` rows likewise;
- TRI: run-date (or latest-trading-date) `index_tri` rows exist for every benchmark index in
  use, whatever their source (ingester **or manual upload** — while niftyindices is manual-first
  per docs/02 §3, the scheduled run must still pass).
If the precondition fails: the run enters a **wait, not a failed attempt** — the stage exits via
a wait-exit (decrements the `stage_attempts` the CAS claim incremented and nulls
`stage_started_at`, releasing the lease), sets `next_check_at = now() + 1h` (docs/05; cleared
when the precondition passes). Each hourly re-check FIRST re-invokes (pg_net, cron secret) any
ingester whose run-date **data rows** are missing — regardless of its job `ok` flag (all
ingesters are idempotent) — then re-tests. Hard deadline: 12:00 IST on the day after the run
date (derived, not stored); past it, `status='failed'`, `fail_reason='ingest_missing'`.
Consequence: gate G6's plan-time premium check uses same-day price vs same-day NAV. A user-initiated
"Run now" at any other time uses the latest available data and G6 compares the latest price with the
latest NAV, each labeled with its as-of date (dates may differ by one trading day; the plan card
shows both).

## 3. Pipeline driver (resolves "who advances the chain")
`monthly_runs` state machine:
`pending → research → gated → theme_ranked → etf_ranked → allocated → narrated → done`, terminal
`failed`, plus `superseded` (docs/01 §3.5).

- Each stage is one Edge Function invocation that: **claims the run atomically (CAS)** —
  ```
  update monthly_runs set stage_started_at=now(), stage_attempts=stage_attempts+1
   where id=$1 and status=$expected_status
     and (stage_started_at is null or stage_started_at < now() - interval '30 minutes')
   returning id;
  ```
  0 rows returned ⇒ another invocation holds the lease ⇒ exit immediately (this is what makes
  driver ticks and direct chaining race-free — no duplicate LLM calls, no interleaved
  delete-then-insert). On success it does its work idempotently (delete-then-insert its own
  outputs within a transaction — see `recommendation_items` unique indexes in docs/05), then
  completes: advances `status`, resets `stage_attempts=0` **and `stage_started_at=null`**, sets
  `stage_updated_at=now()` (nulling the lease makes the next stage driver-eligible on the very
  next tick).
- **run-driver** (cron, every 10 min): picks runs not in `done|failed|superseded` where the lease
  test above passes (the `coalesce` covers a stage that crashed before its first completion —
  `stage_updated_at` may still be NULL) and, for waiting runs, `now() >= next_check_at`;
  re-invokes the current stage. **Max 3 attempts per stage** (ingest-precondition waits do NOT
  count — §2), then `status='failed'` with the last error as `fail_reason`.
- Stages may also chain directly (stage k fires stage k+1 on success) for latency; the driver is
  the correctness backstop.
- Idempotency: every stage can be re-run from its checkpoint without duplicating rows (schema
  enforces via unique indexes; stages write with upsert/delete-then-insert).

## 4. Freshness gates before any plan
1. Price/NAV within 3 trading days (§1) — else fail `stale_data`.
2. Same-day ingest precondition for scheduled runs (§2).
3. **Metrics freshness**: an ETF whose latest `etf_metrics.as_of` is older than **45 days**, or
   whose gate-relevant snapshot fields (AUM, TER, TE) are NULL, **fails eligibility** with reason
   `stale_metrics` (it is gated out, never guessed). `adtv_paise` and `premium_discount_30d` are
   computed from price/NAV ingestion and are covered by gates 1–2 above, not this check.
   Unresolved `metrics_review_queue` entries at run time therefore exclude those ETFs; the plan
   card lists them under "excluded: stale metrics".

## 5. Backups & restore
**NOT BUILT (owner decision, 2026-07-24): no backups wanted for this personal instance.**
`export-backup` does not exist; the spec below is retained as a reference for if this changes
later (docs/07 §13 item 15) — there is currently no recovery path for user data beyond whatever
Supabase itself provides at the project's plan tier.
- Nightly `export-backup`: dumps **all user-owned tables** (`profiles`, `transactions`,
  `fy_exemption_inputs`, `user_charges_overrides`, `run_acknowledgements`, `monthly_runs`,
  `recommendation_items`, `feedback_scores`) plus non-re-ingestable shared data
  (`theme_research` — historical LLM output cannot be regenerated; `nse_holidays` — manually
  seeded; `etf_metrics` where `source='manual'`; `metrics_review_queue`) as CSV/JSON to the
  private Storage bucket (docs/09 §7). Retention: the last **30 daily** exports (the single
  authoritative figure — §2 sweep and docs/09 §7 use the same number). Log to `job_runs`.
- Market data (prices/NAV/TRI) is NOT backed up — it is re-ingestable from source.
- **Restore procedure** (order follows the FK graph in docs/05):
  1. `nse_holidays` → 2. `profiles` → 3. config inputs (`user_charges_overrides`,
  `fy_exemption_inputs`) → 4. `theme_research` → 5. `monthly_runs` → 6. `transactions`
  (plan-sourced rows FK onto monthly_runs) → 7. `recommendation_items`, `feedback_scores`,
  `run_acknowledgements` → 8. `etf_metrics` manual rows, `metrics_review_queue`.
  Then re-run ingesters for market data.

## 6. Alerting & observability
- **Dashboard banner** reads `job_runs where (ok=false or (ok is null and started_at <
  now()-interval '30 minutes')) and started_at > now()-interval '7 days'` plus unresolved
  `ingest_quarantine` rows — rendered on the Dashboard screen (docs/01 §4 screen 2). The
  `ok is null and started_at < 30 min` leg matters: a job's row is written at start with `ok`
  left `NULL` and only set at completion (`job-log.ts` `startJob`/`finishJob`) — a hard crash
  or OOM kill between the two (e.g. an ingester killed mid-fetch) leaves an orphaned row that
  `ok=false` alone would never match, silently vanishing from both this banner and the
  health-check streak count below. 30 minutes comfortably exceeds any single ingester's
  expected runtime (docs/10 §8 wall-clock budget) without false-flagging a merely slow-but-live
  invocation. The same predicate applies to the health-check consecutive-failure count.
- **Push channel**: daily `health-check` sends an email via **Resend** (resolved build-order step
  6, 2026-07-24 — plain `fetch`, no SDK; keys = `EMAIL_API_KEY`/`ALERT_EMAIL_TO`/`ALERT_EMAIL_FROM`,
  docs/09 §3) when: the same job has failed **≥ 3 consecutive** runs; a monthly run is `failed`
  (within the last ~26h, so it's not re-alerted forever on the same stale failure); or month-to-date
  LLM spend ≥ **$0.50** (the docs/01 §6 alert threshold). The fourth trigger listed here in earlier
  drafts — "approaching a detectable free-tier limit" — is NOT implemented: there is no concrete,
  pollable signal for it from within an Edge Function (docs/07 §13 item 9).
- `job_runs` retention: 180 days (weekly sweep).
- LLM observability: each Anthropic call's actual cost (from the API usage block) is written into
  `monthly_runs.llm_cost_usd` **immediately after the response returns, before any further stage
  work** — a stage that crashes mid-way must not leave spend invisible to the cap check.

## 7. LLM spend cap (mechanics)
- Cap: **$2 / calendar month, global** (all users, all runs, all retries).
- Before **every** Anthropic call, the stage sums `llm_cost_usd` over `monthly_runs` where
  `run_month` = the current calendar month; if ≥ cap, the research stage skips to the deterministic fallback set
  (docs/03 §2.5) and narrative stages fall back to numbers-only display. The run continues —
  the pipeline never blocks on the LLM or the cap.
- Forced re-research (docs/02 §5) counts against the same cap.

## 8. Free-tier operational limits (all `VERIFY-AT-SEED` at build step 1)
- Edge Function wall-clock limit on the current free plan (historically ~150–400 s; pin the number
  and keep every stage's budget < 60 % of it).
- pg_cron and pg_net availability on the free plan.
- Storage quota vs backup retention math.
- **Project inactivity pausing**: Supabase pauses inactive free projects — fatal for a
  monthly-cadence app. Verify whether nightly cron/Edge activity counts as activity; if not,
  decide keep-alive vs paid plan (owner open item, docs/07 §13).
