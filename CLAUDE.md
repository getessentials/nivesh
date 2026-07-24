# NiveshETF — Monthly ETF Investment Advisor (India)

## ⚠️ PHASE 0 — MANDATORY, BEFORE ANY CODE IS WRITTEN
On first run in this repo, do NOT scaffold, install, or write any code yet. First:
1. Spawn reviewer subagents IN PARALLEL — engineer, security, ops, quant, business (mandates
   defined in "Review protocol" below) — each reads ALL docs (CLAUDE.md + docs/01–07) end to end
   and returns findings: gaps, contradictions between docs, stale assumptions, missing specs.
2. Additionally spawn a **data-verifier** subagent for Phase 0 only: verify the seed universe
   against live sources (docs/03 §6 theme table, tickers, AMFI scheme codes, current AUMs, whether
   the docs/02 endpoints still respond as described) using web access if available; anything
   unverifiable gets marked `VERIFY-AT-SEED` in the docs rather than assumed.
3. Loop: apply the findings by EDITING the docs (update existing files, or ADD new numbered docs,
   e.g. docs/08-*, if a topic deserves its own file), then re-run the reviewer set on the updated
   docs. Repeat until a full pass returns no material findings (max 3 loops; leftover items go into
   docs/07 §"Open items" for the owner).
4. Record the Phase 0 outcome as a new section at the top of docs/07-gap-analysis.md: findings,
   doc edits made, docs added, items deferred to owner.
5. Print a short Phase 0 summary to the owner and WAIT for explicit "go" before starting
   build-order step 1. Docs are the contract; the contract gets reviewed before it gets executed.

## What this is
A personal (product-later) web app that, once a month, takes an investable amount X (₹) and produces a
ranked, explained, tax-aware ETF buy plan for Indian markets:

1. Profile: user age + risk appetite → equity glide path + core/satellite split.
2. Themes: 1–5 ranked wealth-creation themes (defence, manufacturing, AI/IT, infra, PSU, gold, etc.),
   each with a written rationale ("why #1 over #2").
3. ETFs: 1–5 ranked ETFs per selected theme, chosen by a deterministic scoring engine
   (tracking difference, tracking error, TER, AUM, liquidity, peer-relative returns, momentum).
4. Allocation: whole-unit allocation of X across the picks with explanation; leftover reported as carry.
5. Portfolio-aware: considers existing holdings (manual entry now, broker sync later) — a feedback
   scoring rule ("stick with winners, rotate losers, respect tax drag").
6. Charting: holding vs its benchmark TRI vs rival ETFs on the same index.
7. Tax: FIFO lots, LTCG/STCG per asset class (post-Finance-Act-2024 rules), full charges stack.

## Architecture (locked)
- Frontend: React + Vite + TypeScript, Redux Toolkit, shadcn/ui, Recharts. Deployed on Vercel.
- Backend: Supabase (Postgres + Auth + Edge Functions + pg_cron). **No separate Node/Express server**
  — cost optimization; all pipeline logic lives in Supabase Edge Functions (Deno/TS) invoked by pg_cron.
- LLM: Anthropic API called ONLY from Edge Functions (never from browser). Sonnet (with web search
  tool) for the monthly theme-research pass; Haiku for narrative generation. Prompt caching on.
- Data: free EOD sources only (mfapi.in, AMFI NAVAll.txt, Yahoo Finance `.NS`, niftyindices.com TRI).
  No licensed real-time data.

## Core invariant: LLM proposes, deterministic disposes
No LLM output reaches a recommendation, allocation, or tax number.
- LLM MAY: propose candidate themes with macro rationale, write explanations, summarize research.
- LLM MAY NOT: pick ETFs, set weights, compute allocations, compute tax, invent tickers or numbers.
- Every LLM theme proposal passes a deterministic **investability gate** (docs/03) before it can rank.
- Every number shown to the user is computed by pure TypeScript functions with unit tests.
- LLM structured output validated with Zod; on validation failure, retry once, then fall back to the
  deterministic default theme set (docs/03 §2.5).

## Money & math invariants (same as my other projects)
- All money in integer paise. Floats are permitted in scoring/percentiles/weight derivation only;
  every ₹ figure crosses to integer paise exactly once (`floor(weight × sleeve_paise)`, docs/08 §5) —
  downstream unit, charge, and tax math is integer-paise only, no floats ever.
- Holdings quantity is derived from the transactions (lots) table — never stored as a mutable total.
- Allocation is whole ETF units only (floor), greedy remainder pass, residual cash reported.
- Tax engine is a pure function: (lots, sells, config) → breakdown. Tax rates live in a
  `tax_config` table with effective-date ranges, NOT hardcoded (rules changed in 2023, 2024, 2025;
  they will change again).

## Compliance posture
Personal tool today, product later. From day 1:
- Every recommendation screen carries: "Educational analysis, not investment advice. Not SEBI-registered."
- No auto order placement. Recommend-only. Broker sync (when added) is read-only import.
- If productized: SEBI RIA / RA registration is required **before the app produces personalized
  recommendations for any user other than the owner — paid or free** (SEBI treats indirect
  monetization as consideration and has enforced against free distribution); charging is a second,
  stricter trigger. Treat as a hard gate, not a disclaimer problem. Until registered, any
  multi-user output must be restructured as non-personalized research.

## Build order (do it in this order; each step has tests before the next starts)
0. PHASE 0 doc review by subagents (top of this file) — build starts only after owner says "go".
1. `supabase/migrations/` from docs/05-database-schema.sql. Seed `etfs`, `themes`, `theme_etf_map`,
   `tax_config`, `charges_config` from docs/03 + docs/04 seed tables.
2. Data ingestion Edge Functions: `ingest-nav` (mfapi.in + AMFI), `ingest-prices` (Yahoo `.NS`),
   `ingest-tri` (niftyindices), `refresh-metrics` (monthly AUM/TER/TE/TD upsert — manual-assisted, see docs/02 §4).
3. `packages/engine/` — pure TS, zero I/O: scoring (docs/03), allocation (docs/03 §4), feedback (docs/03 §5),
   tax + charges (docs/04). Vitest, ≥90% branch coverage on engine. Golden-file tests for the worked examples in docs.
4. Monthly pipeline Edge Function `monthly-run`: profile → theme gate → LLM research → deterministic
   rank → ETF scoring → allocation → narratives → persist `monthly_runs` + `recommendation_items`.
5. Frontend: onboarding (age/risk), dashboard, monthly plan view (ranked themes → ranked ETFs →
   allocation table), portfolio entry (lot form + CSV import), performance charts, tax report screen.
   Use the frontend-design skill for the visual pass; data-dense, chart-forward, no template look.
6. Vercel deploy + Supabase pg_cron schedule (1st trading day of month, **23:30 IST — after
   prices, NAV and TRI have all landed**; cron catalog and first-trading-day logic in docs/10 §2).

## Review protocol (for Claude Code: use real subagents here)
This protocol runs FIRST as Phase 0 against the docs themselves (see top of file), and then again
after each build-order step against the code. Spawn reviewer subagents in parallel and loop until all return no
material findings (max 3 loops, then surface remaining items to the owner):
- **engineer**: correctness, edge cases, Deno/browser isomorphism of `packages/engine` (no Node
  APIs, no process.env), Edge Function time limits, idempotency of ingesters.
- **security**: RLS coverage on every user table, JWT required on all function invocations, no
  service-role key client-side, CSV import size cap + strict parse, LLM web content treated as
  untrusted (Zod against seeded theme keys; LLM influence capped at theme-policy factor only).
- **ops**: staleness gate before any plan (abort if price/NAV older than 3 trading days), job
  failure surfaced as dashboard banner, nightly `transactions` export to Supabase Storage,
  pg_cron schedules written in UTC with IST conversion comments.
- **quant**: percentile fallbacks for cohorts < 4 (score vs full thematic universe, flag "small
  cohort"), TRI-only comparisons, integer-paise math, golden tests E1–E5 passing.
- **business**: disclaimer present on every recommendation surface, no auto-execution paths,
  shared-research/per-user-narrative cost split preserved.

## Pipeline execution constraint (hard)
`monthly-run` is NOT one function call. Each stage (research → gate → theme rank → etf rank →
allocation → narratives) is a separate Edge Function invocation chained via `monthly_runs.status`
checkpoints — Edge Functions have wall-clock limits of a few minutes and the LLM+web-search stage
alone can approach them. Every stage idempotent and resumable from its checkpoint. The chain is
advanced and retried by the `run-driver` dispatcher (pg_cron every 10 min, stage leases, max 3
attempts per stage) — full state machine in docs/10 §3; cron auth model in docs/09 §2.

## Non-goals (v1)
- No order execution, no broker API, no real-time quotes, no intraday anything.
- No true reinforcement learning (see docs/07 — infeasible at 1 decision/month; we use a
  deterministic feedback score instead and we say so honestly in the UI).
- No international FoF purchases until the RBI-limit subscription status check is implemented (docs/02 §6).

## Docs index
- docs/01-PRD.md — product spec, flows, screens
- docs/02-data-sources.md — every data source, endpoint, refresh cadence, fallbacks
- docs/03-scoring-and-allocation-engine.md — theme gate, ETF score, allocation, feedback loop (exact formulas)
- docs/04-tax-and-charges-engine.md — FIFO, LTCG/STCG rules per asset class, charges stack (exact rules + worked examples)
- docs/05-database-schema.sql — full Supabase schema
- docs/06-architecture-and-cost.md — infra layout, LLM usage, cost budget (target ≤$0.50/mo LLM, hard cap $2)
- docs/07-gap-analysis.md — review-pass findings and the design decisions they forced (read this first)
- docs/08-computation-conventions.md — percentiles, windows, return bases, rounding, float↔paise boundary
- docs/09-security-and-access.md — RLS matrix, Edge Function auth (incl. cron), secrets, ingestion integrity
- docs/10-operations-runbook.md — market calendar, cron catalog (UTC), pipeline driver, backups, alerting, free-tier limits
- docs/11-deployment-checklist.md — everything left after build-order step 6: account setup, Supabase/Vercel one-time config, credential hand-off, post-deploy smoke test
