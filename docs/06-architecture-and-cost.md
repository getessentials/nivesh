# 06 — Architecture & Cost

## 1. Topology (chosen for near-zero fixed cost)
```
Browser (React+Vite+TS, Redux Toolkit, shadcn/ui, Recharts)
   │  supabase-js (RLS-scoped reads/writes only)
   ▼
Supabase  ── Postgres (all data) ── pg_cron (schedules)
   └── Edge Functions (Deno/TS):
        ingest-prices | ingest-nav | ingest-tri | refresh-metrics
        monthly-run + per-stage pipeline functions | run-driver
        export-backup | health-check | retention-sweep | admin-* (docs/09 §2.1)
        LLM stages → Anthropic API (server-side key in function secrets)
Vercel: static hosting of the Vite build only. NO server runtime on Vercel.
```
Why no Node/Express (deviation from my usual stack, justified): the app has exactly one heavy
workflow, monthly and async. Edge Functions + pg_cron cover it inside Supabase free tier; a Railway
service would be an always-on cost for a once-a-month job. The engine stays a pure TS package
(`packages/engine`) imported by both Edge Functions and (for instant what-if UX like the sell
planner) the frontend — same code computes both, server result is canonical.

Pipeline chaining: pg_cron cannot call HTTP; jobs invoke functions via **pg_net** with a cron
secret (auth model: docs/09 §2), and the multi-stage monthly run is advanced/retried by the
**run-driver** dispatcher with stage leases and attempt caps (state machine: docs/10 §3).

Repo layout (pnpm workspaces):
```
apps/web            # Vite app
packages/engine     # pure scoring/allocation/tax (the crown jewel — mirrors Threshold pattern)
packages/shared     # zod schemas, types, constants
supabase/functions  # edge functions (thin I/O wrappers around engine)
supabase/migrations
```

## 2. LLM usage & budget
| Call | Model | When | Est. tokens | Est. cost |
|---|---|---|---|---|
| Theme research (web search tool) | Sonnet | 1×/month | ~15–30k total | ~$0.10–0.25 |
| Narratives (theme + ETF + allocation "why") | Haiku | 1×/month, batched into 1–2 calls | ~10k | ~$0.02 |
Guards: prompt caching on the static rubric; `theme_research` cached per month (keyed by month —
one research pass serves all users, docs/05); hard **global** monthly spend cap of $2 — before
every Anthropic call the stage sums the month's `llm_cost_usd` across all runs and skips to the
fallback set if exceeded (mechanics: docs/10 §7). Target ≤ $0.50/mo.

## 3. Everything-else budget
- Supabase free tier: 500MB DB — EOD rows for ~40 ETFs ≈ 40 × 250 rows/yr × few cols → trivial for years.
  Operational free-tier limits (Edge Function wall-clock, pg_cron/pg_net availability, Storage
  quota, **project inactivity pausing** — fatal for a monthly-cadence app): pinned list with
  `VERIFY-AT-SEED` markers in docs/10 §8.
- Vercel hobby: static only, free. No image optimization, no middleware.
- Data sources: all free (docs/02; licensing posture for the product phase: docs/02 §8).
  Nightly functions each run seconds.
- Total: ~$0 infra + LLM (target ≤ $0.50/mo, hard cap $2 — the single budget statement, §2).
  When productized: RLS is already multi-tenant; the cost line that
  changes is LLM (research is shared by schema design — `theme_research` is keyed by month, not
  run; only narratives are per-user).

## 4. Frontend notes
- Redux Toolkit: RTK Query against supabase (or thin wrappers); slices: profile, plan, portfolio, taxes.
- Charts: Recharts; always plot TRI-normalized series (base 100 at comparison start), annotate buy dates.
- Apply the frontend-design skill for the visual pass: this is a data instrument, not a marketing
  page — design around the numbered ranking cards and the factor-breakdown bars as the signature
  element; avoid template fintech gradients.
- Perf: code-split routes; charts lazy; EOD data means aggressive SWR caching (staleTime 12h).

## 5. Security
Authoritative spec: **docs/09-security-and-access.md** (RLS matrix, function auth modes incl.
cron, secrets inventory, signup posture, ingestion integrity, CSV/LLM hardening). Summary:
Anthropic key only in Edge Function secrets; anon key + RLS for the browser; no service-role key
client-side ever; cron jobs authenticate with a Vault-held secret via pg_net; public signups
disabled in v1; rate-limit `monthly-run` invocations per user (1/day).
