-- 05 — Supabase schema (Postgres). RLS ENABLE + FORCE on every table; policies per the
-- authoritative access matrix in docs/09 §1 (summarized inline here).
-- Money: bigint paise. Percentages: numeric(8,4). Dates: date for EOD data, timestamptz for events.

-- ===== Profile =====
create table profiles (
  user_id uuid primary key references auth.users,
  dob date not null,
  risk text not null check (risk in ('conservative','moderate','aggressive')),
  default_amount_paise bigint not null default 0,
  tax_slab_pct numeric(5,2) not null default 30.00,      -- for slab-taxed classes
  broker_profile text not null default 'discount_default',
  core_index text not null default 'NIFTY 50',           -- deterministic core index (docs/03 §1)
  non_equity_sleeve text not null default 'gold' check (non_equity_sleeve in ('gold','debt')),
  created_at timestamptz default now()
);

-- FY-scoped "equity LTCG exemption used outside the app" (docs/04 §2.1). Point-in-time user
-- assertion; entered_on records when the user last updated it within the FY.
create table fy_exemption_inputs (
  user_id uuid not null references auth.users,
  fy text not null,                       -- 'FY2026-27' (Apr–Mar)
  used_elsewhere_paise bigint not null default 0,
  entered_on date not null,
  primary key (user_id, fy)
);

-- ===== Reference =====
-- Canonical index registry: the ONE spelling used by etfs.underlying_index,
-- themes.benchmark_index and index_tri.index_name (they all FK here).
create table indices (
  name text primary key,                  -- 'NIFTY INDIA DEFENCE TRI'
  tri_source text not null default 'niftyindices'
    check (tri_source in ('niftyindices','nav_proxy','manual','none')),
    -- 'none' = underlying-only row (no TRI series expected, e.g. plain 'NIFTY 50')
  notes text
);

create table themes (
  key text primary key,                 -- 'defence', 'manufacturing', ...
  name text not null,
  investable boolean not null default true,
  proxy_note text,
  benchmark_index text references indices(name),
  -- investable themes MUST name a benchmark series (docs/03 §6); proxies flagged in indices.tri_source
  check (not investable or benchmark_index is not null)
);

create table etfs (
  id serial primary key,
  isin text unique not null,
  name text not null,
  yahoo_symbol text not null,           -- 'MODEFENCE.NS'; pinned, never runtime-resolved
  amfi_scheme_code text,                -- mfapi.in key; beware legacy duplicates (docs/02 §2)
  underlying_index text not null references indices(name),  -- one-per-index rule key
  asset_class text not null check (asset_class in ('equity','gold','silver','debt','intl')),
  intl boolean not null default false,
  check (intl = (asset_class = 'intl')),   -- one source of truth, kept queryable
  ltcg_months int,                      -- per-instrument OVERRIDE only (docs/04 §2.4 precedence);
                                        -- null = use tax_config.ltcg_months
  exit_load_pct numeric(6,3) not null default 0,
  exit_load_days int not null default 0,
  listed_on date,
  active boolean not null default true
);

create table theme_etf_map (
  theme_key text references themes(key),
  etf_id int references etfs(id),
  primary key (theme_key, etf_id)
);

-- nav_proxy benchmark series (gold, silver, ai_global_tech, debt_liquid — docs/03 §6) are the
-- NAV series of ONE pinned ETF, chosen at seed time and never floated ("largest" would drift):
alter table indices add column proxy_etf_id int references etfs(id);
alter table indices add constraint indices_proxy_chk
  check (tri_source <> 'nav_proxy' or proxy_etf_id is not null);
-- The engine reads etf_navs of proxy_etf_id as the benchmark series; nothing is copied into
-- index_tri for nav_proxy indices.
-- Seed order note: nav_proxy index rows must be inserted AFTER their proxy ETF exists, and a
-- nav_proxy index name must be distinct from any etfs.underlying_index value (a gold ETF's
-- underlying index is its own non-proxy row).

create table nse_holidays (              -- trading calendar (docs/10 §1); seeded annually
  d date primary key,
  label text
);

-- ===== Time series (EOD) =====
create table etf_prices (      -- exchange price
  etf_id int references etfs(id),
  d date not null,
  close_paise bigint not null,
  volume bigint,
  traded_value_paise bigint,
  primary key (etf_id, d)
);

create table etf_navs (
  etf_id int references etfs(id),
  d date not null,
  nav_paise bigint not null,
  primary key (etf_id, d)
);

create table index_tri (
  index_name text not null references indices(name),
  d date not null,
  value numeric(14,4) not null,
  primary key (index_name, d)
);

create table etf_metrics (     -- monthly snapshot; source: AMFI/AMC factsheets (+ manual queue)
  etf_id int references etfs(id),
  as_of date not null,
  aum_cr numeric(12,2),
  ter_pct numeric(6,3),
  tracking_error_1y numeric(8,4),
  tracking_diff_1y numeric(8,4),
  tracking_diff_3y numeric(8,4),
  tracking_diff_5y numeric(8,4),
  adtv_paise bigint,                    -- computed from etf_prices
  premium_discount_30d numeric(8,4),    -- computed price vs nav
  source text not null default 'manual',
  primary key (etf_id, as_of)
);

-- Rows failing ingestion sanity gates (docs/09 §5) are quarantined here, never upserted.
create table ingest_quarantine (
  id bigserial primary key,
  job text not null,
  natural_key text not null,             -- e.g. 'etf_id=12,d=2026-07-22'
  raw jsonb not null,
  reason text not null,                  -- 'nonpositive' | 'jump>20%' | 'future_date' | ...
  resolved boolean not null default false,
  created_at timestamptz default now()
);

-- ===== Config (effective-dated; engine looks up by relevant date) =====
-- Resolution rule (docs/04 §1): pick the row where sell_date ∈ [effective_from, effective_to]
-- AND buy_date ∈ [acquired_from, acquired_to]; null bounds are open-ended. Rows for one
-- asset_class must not overlap on that 2-D range (enforced by seed review, asserted in tests).
create table tax_config (
  id serial primary key,
  asset_class text not null,
  effective_from date not null,          -- sell-date range
  effective_to date,
  acquired_from date,                    -- buy-date range (null = any) — transition rules
  acquired_to date,
  stcg_mode text not null check (stcg_mode in ('flat','slab')),
  stcg_rate_pct numeric(5,2),
  ltcg_months int not null,
  ltcg_rate_pct numeric(5,2) not null,
  ltcg_exemption_paise bigint not null default 0,   -- 1.25L for equity, 0 otherwise
  cess_pct numeric(5,2) not null default 4.0
);

create table charges_config (
  broker_profile text not null,
  charge_key text not null,             -- 'brokerage','stt_sell','stamp_buy','txn','sebi','dp_sell_flat','gst'
  asset_class text not null default 'equity',
  side text not null check (side in ('buy','sell','both')),
  kind text not null check (kind in ('pct','flat_paise')),
  value numeric(12,6) not null,
  tax_deductible boolean not null default true,   -- STT rows: false (s.48 proviso, docs/04 §3)
  effective_from date not null,
  effective_to date,
  primary key (broker_profile, charge_key, asset_class, effective_from)
);
-- GST composition convention (fixed, documented in docs/04 §3): the 'gst' row's pct applies to
-- the SUM of the unrounded 'brokerage' + 'txn' + 'sebi' bases of the same order. No base_keys
-- column; the convention is part of the engine contract (docs/08 §6).

-- Per-user charge overrides (docs/09 §1: global config is never client-writable).
create table user_charges_overrides (
  user_id uuid not null references auth.users,
  charge_key text not null,
  asset_class text not null default 'equity',
  side text not null check (side in ('buy','sell','both')),
  kind text not null check (kind in ('pct','flat_paise')),
  value numeric(12,6) not null,
  tax_deductible boolean not null default true,
  primary key (user_id, charge_key, asset_class)
);
-- Engine resolution: user override → broker profile row → error (no silent defaults).

-- ===== User data =====
create table transactions (             -- lots; holdings are ALWAYS derived from this
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  etf_id int not null references etfs(id),
  side text not null check (side in ('buy','sell')),
  qty int not null check (qty > 0),
  price_paise bigint not null,
  charges_paise bigint not null default 0,
  traded_on date not null,
  source text not null default 'manual'
    check (source in ('manual','plan','csv','broker')),
  run_id uuid,                              -- link to monthly run if from a plan
                                            -- (FK added below, after monthly_runs exists)
  created_at timestamptz default now()
);
create index on transactions (user_id, etf_id, traded_on);
-- Oversell guard: sell inserts (UI and CSV import) are validated by the engine against
-- FIFO-available qty on the trade date; buy-row DELETEs/edits are re-simulated the same way —
-- rejected if any later sell becomes uncovered (docs/09 §6). APP-PATH enforced (no DB trigger):
-- a direct PostgREST write under the user's own JWT could store an invalid sequence, harming
-- only that user's numbers; the engine re-validates on read. Accepted for v1.
-- run_id ownership: RLS with-check clause requires run_id IS NULL OR the run belongs to
-- auth.uid() (see RLS section) — a user cannot link lots to another user's run.

create view holdings
  with (security_invoker = true) as      -- view evaluates the QUERYING user's RLS, not the
                                         -- owner's — without this the view leaks all users' rows
  -- derived, never stored. QTY ONLY — avg cost / invested / unrealized P&L are NOT derivable
  -- by aggregate SQL after partial sells (FIFO cost relief is lot-order-dependent); they are
  -- computed exclusively by the engine's FIFO lot walk over transactions (docs/04 §1).
  select user_id, etf_id,
         sum(case when side='buy' then qty else -qty end) as qty
  from transactions group by user_id, etf_id
  having sum(case when side='buy' then qty else -qty end) > 0;

-- ===== Monthly pipeline =====
-- Shared monthly LLM research (one pass per month serves all users — docs/06 §3, docs/09 SEC-7).
create table theme_research (
  research_month date primary key,       -- first of month
  payload jsonb not null,                -- zod-validated candidates + citations
  model text not null,
  forced boolean not null default false, -- owner forced a re-research this month
  created_at timestamptz default now()
);

create table monthly_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  run_month date not null,
  seq int not null default 1,             -- re-runs supersede (docs/01 §3.5)
  amount_paise bigint not null,           -- user's X for this run (excludes carry)
  carry_in_paise bigint not null default 0,
  -- carry_in = residual_paise of the most recent DONE, non-superseded run with an earlier
  -- (run_month, seq) — failed/superseded runs are skipped (docs/03 §4 step 5).
  residual_paise bigint,                  -- written by the allocation stage
  -- spendable = amount_paise + carry_in_paise (docs/03 §4); carry is consumed exactly once,
  -- by the month's final (non-superseded) run.
  research_month date references theme_research(research_month),
  status text not null default 'pending',
    -- pending|research|gated|theme_ranked|etf_ranked|allocated|narrated|done|failed|superseded
  fail_reason text,
  stage_started_at timestamptz,           -- driver lease (docs/10 §3; claimed via CAS update)
  stage_updated_at timestamptz,
  stage_attempts int not null default 0,
  next_check_at timestamptz,              -- ingest-precondition wait (docs/10 §2) — waiting is
                                          -- NOT a stage attempt; hourly re-check until deadline
  llm_cost_usd numeric(8,4) not null default 0,  -- accumulated per stage; global cap docs/10 §7
  created_at timestamptz default now(),
  unique (user_id, run_month, seq)
);

alter table transactions
  add constraint transactions_run_fk foreign key (run_id) references monthly_runs(id);

-- User acknowledgement of plans (reviewed / superseded-acknowledged). Kept OUT of monthly_runs:
-- RLS cannot column-scope an UPDATE, and any user UPDATE on monthly_runs would expose status
-- and llm_cost_usd (the spend-cap accumulator) to tampering — docs/09 §2.3.
create table run_acknowledgements (
  user_id uuid not null references auth.users,
  run_id uuid not null references monthly_runs(id),
  kind text not null check (kind in ('reviewed','superseded_ack')),
  at timestamptz not null default now(),
  primary key (user_id, run_id, kind)
);

create table recommendation_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references monthly_runs(id),
  level text not null check (level in ('theme','etf')),
  theme_key text references themes(key),
  etf_id int references etfs(id),
  rank int not null,
  score numeric(6,2) not null,
  factor_json jsonb not null,            -- full factor table (auditable "why")
  narrative text,                        -- Haiku phrasing of factor_json (plain text, docs/09 §8)
  alloc_paise bigint,
  units int,
  weight_target numeric(6,3),               -- FRACTION of X_spendable (0.075 = 7.5%), not percent
  weight_actual numeric(6,3)                 -- same unit
);
-- Idempotent stage re-runs: each stage delete-then-inserts its own level's rows in a
-- transaction; these unique indexes make accidental duplicates impossible (docs/10 §3).
create unique index reco_theme_uniq on recommendation_items (run_id, theme_key)
  where level = 'theme';
create unique index reco_etf_uniq on recommendation_items (run_id, theme_key, etf_id)
  where level = 'etf';

create table feedback_scores (           -- decayed adjustments (docs/03 §5)
  user_id uuid not null references auth.users,
  scope text not null check (scope in ('theme','etf')),
  ref text not null,                     -- theme_key or etf_id::text
  adj numeric(6,2) not null,             -- POST-DECAY CUMULATIVE as of as_of:
                                         -- adj_t = clamp(adj_{t-1} * 2^(-Δm/6) + increment, ±cap)
  as_of date not null,
  detail jsonb not null,                 -- excess, peerGap, status history
  primary key (user_id, scope, ref, as_of)
);

create table job_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  rows int,
  error text
);
-- Retention: 180 days (docs/10 §6 weekly sweep).

-- Metrics review queue for manual-assisted refresh (docs/02 §4)
create table metrics_review_queue (
  etf_id int references etfs(id),
  as_of date not null,
  missing_fields text[] not null,
  resolved boolean not null default false,
  primary key (etf_id, as_of)
);

-- ===== RLS (docs/09 §1 is the authoritative matrix; this block implements it) =====
-- Every table: ENABLE + FORCE row level security. Service role bypasses RLS (Supabase default).
-- alter table <t> enable row level security; alter table <t> force row level security;  -- ALL tables
--
-- Owner-scoped CRUD (user_id = auth.uid()):
--   profiles, fy_exemption_inputs, user_charges_overrides
--     create policy own_all on <t> for all using (user_id = auth.uid()) with check (user_id = auth.uid());
--   run_acknowledgements: SELECT + INSERT own only (matrix: no UPDATE/DELETE), with-check also
--     requires the acked run to belong to auth.uid() (same run-ownership clause as transactions);
--   transactions: own CRUD as above, PLUS the with-check clause also requires
--     (run_id is null or exists (select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid()));
--   monthly_runs: SELECT own ONLY. No client INSERT/UPDATE/DELETE whatsoever — status and
--     llm_cost_usd are pipeline/spend-cap state (docs/09 §2.3); creation via Edge Function.
--   feedback_scores: SELECT own ONLY (pipeline-computed; service-role written).
--   recommendation_items: SELECT via run-ownership join:
--     create policy own_read on recommendation_items for select
--       using (exists (select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid()));
--     no client write policies (pipeline output, service-role written).
--   theme_research: SELECT for authenticated (global, contains no user data); no client writes.
--   holdings view: security_invoker (above) + grant select to authenticated — inherits the
--     transactions policies of the querying user.
--
-- Read-only reference/market/config/ops tables for authenticated users (SELECT policy only;
-- writes are service-role only): indices, themes, etfs, theme_etf_map, nse_holidays, etf_prices,
-- etf_navs, index_tri, etf_metrics, tax_config, charges_config, job_runs.
-- metrics_review_queue, ingest_quarantine: SELECT only for authenticated; resolution happens
-- through the owner-admin Edge Functions (docs/09 §2.1), service-role write — clients never
-- UPDATE these (a tenant flipping resolved/raw would silence or poison global ingestion).
