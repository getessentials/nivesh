# 07 — Gap Analysis (review-pass findings → design decisions)

## 0. PHASE 0 OUTCOME (2026-07-23 — subagent doc review before any code)
Five reviewer subagents (engineer, security, ops, quant, business) + a data-verifier with web
access reviewed CLAUDE.md + docs/01–07 end to end. **~55 findings (≈43 material)**; loop 1 applied
them as doc edits. Loop 2 re-review status recorded at the end of this section.

**Docs added:**
- docs/08-computation-conventions.md — percentile method, windows, NAV/price/TRI return-basis
  contract, rounding rules, float↔paise boundary (QNT-2/9/10/11/13/16).
- docs/09-security-and-access.md — RLS access matrix, dual-mode function auth (JWT + cron secret
  via pg_net/Vault), secrets inventory, signup posture, ingestion integrity, CSV/LLM hardening
  (SEC-4..12, OPS-7). **Supersedes the blanket wording of SEC-3 below.**
- docs/10-operations-runbook.md — NSE trading calendar + first-trading-day cron pattern, cron
  catalog (UTC), run-driver state machine with stage leases/retries, backup+restore, alerting,
  global LLM spend cap, free-tier limits (OPS-4..13, ENG-17).

**Major doc edits (finding → decision):**
- holdings view demoted to qty-only; avg cost/invested/P&L computed only by the engine's FIFO lot
  walk (ENG-5/QNT-12).
- `tax_config` gains `acquired_from/to` (2-D date resolution for transition rules); `charges_config`
  gains effective dating + `tax_deductible` (STT non-deductible per s.48 proviso); GST base
  convention fixed; `etfs.ltcg_months` demoted to nullable per-instrument override (ENG-6/7/16, QNT-8).
- docs/04 rebuilt around a pinned golden fixture; E1 recomputed charge-inclusive to the paisa;
  rounding rules in docs/08 §6; E5 breakeven formula written out (QNT-8/9/14).
- Bounded softmax given an exact clip-freeze-renormalize algorithm with N-dependent bounds (N=1:
  100%, N=2: 35–65%, N≥3: 10–50%); remainder-pass termination fixed; acceptance-criterion residual
  invariant weakened to match ("cap-bound residual") (ENG-8/9, QNT-5/6).
- Feedback loop: exact decay recurrence, per-lot value-weighted returns, etf_adj injection point
  (S_etf_final), deliberate 16-point max loyalty moat documented, gates-precede-stickiness
  (ENG-10/11, QNT-7/17).
- Every investable theme now has a named benchmark series incl. NAV-proxy fallbacks for
  gold/silver/NASDAQ-100 (schema CHECK); indices reference table kills free-text index-name joins
  (ENG-12/22, QNT-3).
- Core index fixed deterministically (default Nifty 50) instead of scored cross-index; sleeve math
  made explicit; cross-sleeve one-per-index dedup (ENG-19, QNT-18).
- `theme_research` re-keyed by month (shared research — BIZ-2/SEC-7); `monthly_runs` gains
  seq/superseded re-run semantics, residual/carry fields, stage lease columns (BIZ-5, ENG-13/14/17,
  OPS-6); FY-scoped exemption inputs table (ENG-15/BIZ-13).
- Monthly run moved 19:00 → 23:30 IST (after NAV/TRI land) with same-day ingest preconditions
  (OPS-5); metrics staleness gate G7 (OPS-9); quarantine table + ingestion sanity gates (SEC-9).
- Acceptance criteria fixed: <10 min end-to-end, LLM <$0.50/run with $2 global cap (ENG-18,
  BIZ-3/4); disclaimers enumerated per screen + tax disclaimer + export headers (BIZ-6); SEBI gate
  reworded to trigger on distribution, not payment (BIZ-8); "Mark bought" price-confirmation,
  profile-edit, empty/error-state specs (BIZ-10/11/12).
- Data-verifier (live, 2026-07-23): seed table and tickers confirmed (incl. `MODEFENCE.NS`;
  Bharat 22 = `ICICIB22.NS`); AMFI URL redirects to portal.amfiindia.com; mfapi legacy duplicate
  scheme codes warning; niftyindices POST endpoints currently erroring → `VERIFY-AT-SEED` + manual
  CSV path promoted; MON100 at ~20% premium = live G6 evidence; FY2026-27 tax rates confirmed
  unchanged by Budget 2026; STT 0.001% delivery-side confirmed.

**Deferred to owner:** see §13 (extended below).

**Loop 2 (same day):** the five reviewers re-ran against the edited docs. They independently
CONFIRMED the E1–E3 golden arithmetic to the paisa, all cron UTC↔IST conversions, the E5 kink
analysis, SEBI-gate consistency, and the absence of any auto-execution path. They found ~25
remaining/introduced items (10 quant, 10 engineering — 1 a stale-context false positive, 5+4
security, 6+4 ops, 3+7 business, overlapping), all applied as loop-2 edits:
- RLS cannot column-scope UPDATEs → `monthly_runs` is now SELECT-only to clients (spend-cap
  tamper risk closed); review-acks moved to new `run_acknowledgements`; `feedback_scores`
  client-writes removed; ops tables SELECT-only with resolution via new owner-admin Edge
  Functions (admin-upload-tri / admin-submit-metrics / admin-resolve-quarantine / admin-force-
  research); `holdings` view gets `security_invoker` (was a cross-tenant leak).
- Driver liveness: atomic CAS claim (race-free vs direct chaining), `coalesce` staleness test
  (NULL-updated_at deadlock), ingest-precondition = wait state via `next_check_at` (not a stage
  attempt), hourly checks re-invoke failed ingesters, TRI precondition defined on data presence
  (manual uploads satisfy it), cron window widened to days 1–10.
- Backup/restore now follows the FK graph and includes `theme_research` + `nse_holidays`;
  retention unified at 30 daily copies; $0.50 spend alert added to health-check; LLM cost written
  immediately post-response.
- Determinism: two-phase bounded-softmax (Σw=1 proven on the counterexample), remainder-pass cap
  defined (target weight, +2pp), trackingQuality = −|TD| fidelity with 0.6/0.4 1y/3y blend,
  window-endpoint selection + cohort-wide shrink rules, tax floored at 0 for loss slices,
  largest-remainder FIFO tie-break, "net" feedback status as an MV formula, theme scoring cohort
  fixed (excludes broad_core), 30d = 30 trading days ≥20 obs.
- Reachability: `debt_liquid` theme added so the conservative sleeve is scoreable; nav_proxy
  benchmarks pinned via `indices.proxy_etf_id`; ai_global_tech benchmark = MON100 NAV (INR, no
  FX source needed); intl/asset_class CHECK; supersede flow no longer double-counts deployed
  cash; Portfolio screen + onboarding summary added to the disclaimer list.

**Loop 3 (same day, final pass):** security and business returned **NO MATERIAL FINDINGS**
(security walked every client write to a legal path and confirmed no LLM→numbers or
client→global-state route remains; business walked the supersede/partial-purchase story and the
full disclaimer enumeration clean). Quant re-proved the two-phase softmax on adversarial inputs
(Σw=1 for all reachable N≤5), traced a full worked allocation, and re-verified E1–E3 to the
paisa a third time. Engineer re-derived E1 independently and validated docs/05 as a single
migration. Five last mechanical items were found and fixed in place:
- OPS3-1: prices/NAV precondition re-keyed on DATA presence (AMFI-late scenario: a job can log
  ok=true while the source served yesterday's file — re-checks now re-invoke on missing data
  rows, not job status).
- OPS3-2: `failed` is no longer an orphan terminal state ("Run now" over failed = fresh seq+1,
  no supersede dialog) and carry now skips failed/superseded runs instead of silently dropping.
- ENG3-1: CAS lease predicate fixed to test `stage_started_at` (testing `stage_updated_at` —
  the previous stage's completion stamp — readmitted the concurrent-stage race on retries);
  ENG3-2 (waits burning attempts) covered by the wait-exit clause.
- QNT3-1/2/3: remainder-pass cap gloss corrected (satellite-share factor), per-sleeve flooring
  rule added to the float↔paise boundary, TD_3y percentile sub-cohort pinned.
- Plus ~15 minor polish items across docs (supersede carry-edge clamp, late-Mark-bought notice,
  run_acknowledgements INSERT-only + run-ownership check, ADMIN_USER_IDS pinned as the admin
  mechanism, admin uploads inherit CSV limits, constant-time secret compare, debt_liquid
  growth-variant note, feedback_scores writer stage, seed-order note, weight-unit comment).
Residual non-material observations were folded into §13 (items 12–14).

**PHASE 0 STATUS: CONVERGED after 3 loops.** The doc set is the build contract. Build-order
step 1 starts only on the owner's explicit "go".

The original brief was reviewed in iterative passes (data-availability pass, quant-methodology pass,
tax/compliance pass, product pass). Findings below, each with the decision it forced. Read before building.

## 1. Theme wishlist vs Indian reality
Finding: "water" and "rare earth" have NO Indian ETF; "AI" has no pure Indian index ETF (closest:
IT/digital indices, or NASDAQ 100 for global AI exposure with intl tax/RBI caveats).
Decision: `investable` flag + proxy notes (docs/02 §6, docs/03 §6). The app shows the researched
theme and says why it can't be bought here, instead of silently substituting.

## 2. "Reinforcement learning" is the wrong tool — and would be a lie in the UI
Finding: RL needs many decisions and reward signals; we have 1 decision/month, no counterfactuals,
and rewards arriving over years. Any "RL" here would be theater.
Decision: deterministic feedback scoring with decay + explicit stickiness/rotation rules
(docs/03 §5). Same behavior the brief wanted ("performing well → stick"), fully auditable.

## 3. "Top ETF by past profit" is mostly the index, not the ETF
Finding: a thematic ETF's absolute return ≈ its index's return. Ranking wrappers by absolute past
return just re-ranks themes and rewards recency. The wrapper's own quality = tracking difference,
tracking error, TER, liquidity, premium/discount. (SEBI even caps equity ETF tracking error at 2%
and mandates daily TE / monthly TD disclosure — that's the quality data to use.)
Decision: two-layer ranking — theme layer owns "which index", ETF layer owns "which wrapper",
peer-relative returns only (docs/03 §3.2 rationale).

## 4. Whole units break naive % allocation
Finding: ETFs trade in whole units; ₹X × 12% may not divide by unit price; naive rounding either
overspends or strands cash badly.
Decision: floor + greedy remainder pass + carry-forward residual into next month's X (docs/03 §4).

## 5. Price ≠ NAV on thin thematic ETFs
Finding: low-liquidity thematic ETFs trade at premiums/discounts; buying a 2% premium donates 2%.
International ETFs detach worst when RBI limits halt unit creation.
Decision: gate G6 (≤1% premium, checked at plan time), premium column in the plan table, NAV
ingestion is first-class (docs/02 §2).

## 6. Compare against TRI, never the price index
Finding: price-index comparisons flatter ETFs by the dividend yield (~1–1.5%/yr); "beat the index"
claims become fake.
Decision: all benchmarks are Total Return Indices from niftyindices (docs/02 §3).

## 7. Tax rules are a moving target and class-dependent
Finding: post-Budget-2024 regime: equity ETF STCG 20% / LTCG 12.5% over ₹1.25L (12m); gold/silver
STCG at slab, LTCG 12.5% no exemption (12m, for units under current rules); debt at slab always;
intl split by structure with a 24m clock for FoFs; plus 2023–2025 transition wrinkles. Also: ETFs
have NO exit load (FoFs do), and STT on equity ETFs is 0.001% sell-side — not the 0.1% stock rate.
Decision: effective-dated `tax_config`/`charges_config` tables, engine resolves rules by date;
golden-test worked examples E1–E5 (docs/04). The ₹1.25L exemption is an FY-level ledger shared with
his direct-equity sales outside the app — made a user input.

## 8. Churn vs LTCG conflict
Finding: monthly re-ranking naturally suggests rotations that convert would-be LTCG into STCG and
burn charges. The brief's own goals (momentum-follow + tax efficiency) collide.
Decision: rotation proposals must print tax drag + after-tax breakeven; default "hold to LTCG date"
inside the 10–12-month window unless drawdown > 10% vs peers (docs/03 §5).

## 9. Young ETFs (the whole point of thematic) lack history
Finding: e.g. defence ETFs launched 2024 — no 3y/5y record; requiring long history would exclude
exactly the themes the brief cares about.
Decision: G2 = 12 months minimum + shortHistoryPenalty + "young fund" chip; max-common-window
peer comparisons (docs/03 §3.2).

## 10. No clean API for AUM/TER/TE/TD
Finding: disclosures exist (AMC sites + AMFI, SEBI-mandated) but not as one stable API; scraping
aggregators violates ToS.
Decision: monthly `refresh-metrics` with a manual review queue — honest 15-min/month owner cost
(docs/02 §4). Universe capped ~40 ETFs to keep this sane.

## 11. Compliance line
Finding: personalized buy recommendations for others = SEBI RIA/RA territory; fine as a personal
tool, not fine as an unregistered product.
Decision: recommend-only, disclaimers from day 1, registration treated as a launch gate for the
product phase (CLAUDE.md).

## 12. Smaller catches folded into specs
- One-per-index dedup (two Nifty 50 ETFs isn't diversification) → docs/03 §3.3, which also
  produces the "why this over its rival" comparison the brief asked for.
- DP flat charge makes small sells disproportionately expensive → surfaced in sell planner.
- LLM outage must not block the monthly run → fallback theme set (docs/03 §2.5).
- Yahoo symbol drift (learned in Ledger) → symbols pinned in DB, never runtime-resolved.
- Dividend (IDCW) ETF variants complicate return math → prefer growth ETFs in seed universe; record
  IDCW as income if held.

## 13. Open items for the owner (decide during build, not blockers)
1. Broker for charges defaults (Zerodha-style assumed) — confirm actual broker.
2. Non-equity sleeve default: gold vs debt for the conservative remainder.
3. Whether carry-forward residual auto-adds to next month's X (spec'd yes; consumed once by the
   month's final non-superseded run — docs/03 §4).
4. Whether silver gets its own theme slot or rides under gold (spec'd separate).
5. Core index default (spec'd fixed Nifty 50, a Settings field) — confirm, or choose an
   index-level rule (Phase 0, QNT-18).
6. Monthly run moved to 23:30 IST on the 1st trading day so it consumes same-day NAV/TRI
   (Phase 0, OPS-5) — confirm the late-night plan-drop is acceptable vs a next-morning schedule.
7. N=2 theme-weight bounds set at 35–65% (Phase 0, QNT-5) — confirm or pick different bounds.
8. Stickiness moat: etf_adj inside S_etf_final gives a max 16-point incumbent moat, documented as
   deliberate (Phase 0, ENG-10) — confirm.
9. ~~Email provider for failure alerts (docs/10 §6)~~ — **RESOLVED (build-order step 6, 2026-07-24):
   Resend**, via a plain `fetch` call in `health-check/index.ts` (no SDK dependency). Secrets:
   `EMAIL_API_KEY`, `ALERT_EMAIL_TO`, optional `ALERT_EMAIL_FROM` (defaults to Resend's sandbox
   sender). Alert set implemented: >=3 consecutive job failures, a monthly run gone `failed`, and
   the $0.50 month-to-date LLM spend threshold. NOT implemented: "approaching a detectable
   free-tier limit" — no concrete, pollable signal exists for this from an Edge Function today.
10. Supabase free-tier project pausing: verify nightly cron counts as activity; else keep-alive
    or paid plan (docs/10 §8).
11. Data licensing budget before productization (docs/02 §8).
12. Surcharge applicability: docs/04 §2.5 says "surcharge per slab config (owner-level setting)"
    but `profiles` stores only `tax_slab_pct` — confirm whether surcharge applies to the owner
    (income > ₹50L) and where it's stored (suggest a `surcharge_pct` profile field) — Phase 0,
    BIZ2-10.
13. Pinned proxy ETFs for nav_proxy benchmark series (gold, silver, MON100, debt_liquid) —
    choose at seed via `indices.proxy_etf_id`; docs default to the largest-AUM candidate at
    seed date, then frozen. Prefer growth-NAV variants (daily-IDCW liquid ETFs pin NAV — docs/03 §6).
14. Nothing watches the watcher: `health-check` email is the only push channel and its own
    failure is silent (Phase 0, OPS3-5). Acceptable for a personal tool; optionally add a free
    external uptime ping on a health endpoint.
15. **`export-backup` was NOT built (owner decision, 2026-07-24): no backups wanted for this
    personal instance.** docs/10 §5 (nightly export of user-owned tables + non-re-ingestable
    shared data to Storage) and the backup-file-pruning half of the §2 "retention sweep" job are
    both unimplemented as a result — only `job_runs` retention was scheduled (pg_cron migration
    `20260724000001`). Consequence: user data (transactions, monthly_runs, theme_research, etc.)
    has NO recovery path other than Supabase's own project-level backups (paid-tier point-in-time
    recovery, if enabled) — worth revisiting if this ever moves beyond a personal instance.

## 14. Second review cycle (explicit engineer/security/ops/business/quant passes, looped to convergence)
- ENG-1: Edge Function wall-clock limits → monthly-run split into stage-per-invocation chained on
  `monthly_runs.status` checkpoints (see CLAUDE.md "Pipeline execution constraint").
- ENG-2: `packages/engine` must be isomorphic (Deno Edge + browser): no Node APIs, no process.env;
  enforce with a lint rule.
- ENG-3: Yahoo blocks data-center IPs more aggressively than residential — the NSE bhavcopy fallback
  must be fully implemented and tested, not a stub; ingesters retry with jitter.
- ENG-4: pg_cron is UTC; all IST schedules stored as UTC with IST comments.
- SEC-1: LLM theme research consumes web content = untrusted input. Containment (already in design,
  now explicit): Zod validation against seeded theme keys, LLM influence capped at the policy factor
  (≤25% of theme score), zero LLM influence on ETF selection/allocation/tax. Store citations for audit.
- SEC-2: CSV import: 1MB cap, strict schema parse, reject on any malformed row (no partial imports).
- SEC-3: All Edge Function invocations require the user's JWT; per-user rate limit on monthly-run.
- OPS-1: Freshness gate: monthly-run aborts (status='failed', reason logged) if latest price or NAV
  is older than 3 trading days.
- OPS-2: job_runs failures surface as a dashboard banner (no silent failures).
- OPS-3: Nightly export of `transactions` (CSV) to Supabase Storage — free-tier backups are thin and
  lots are unrecoverable data.
- QNT-1: Percentile scoring with cohort < 4 ETFs degenerates → fall back to scoring vs full thematic
  universe, tag item "small cohort" in factor_json.
- BIZ-1: Productization economics: theme research is one shared run/month across all users; only
  narratives are per-user (~Haiku pennies). The engine package is the licensable asset.
Loop 2 re-review of the fixes: status-checkpoint enum extended; freshness threshold defined (3
trading days). Loop 3: no new findings — converged.
