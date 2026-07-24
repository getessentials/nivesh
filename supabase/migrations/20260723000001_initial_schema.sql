-- NiveshETF initial schema. Contract: docs/05-database-schema.sql (annotated version),
-- RLS matrix: docs/09 §1. Money: bigint paise. Percentages: numeric(8,4).
-- Dates: date for EOD data, timestamptz for events.

-- ===== Profile =====
create table profiles (
  user_id uuid primary key references auth.users,
  dob date not null,
  risk text not null check (risk in ('conservative','moderate','aggressive')),
  default_amount_paise bigint not null default 0,
  tax_slab_pct numeric(5,2) not null default 30.00,
  broker_profile text not null default 'discount_default',
  core_index text not null default 'NIFTY 50',
  non_equity_sleeve text not null default 'gold' check (non_equity_sleeve in ('gold','debt')),
  created_at timestamptz default now()
);

-- FY-scoped "equity LTCG exemption used outside the app" (docs/04 §2.1).
create table fy_exemption_inputs (
  user_id uuid not null references auth.users,
  fy text not null,                       -- 'FY2026-27' (Apr–Mar)
  used_elsewhere_paise bigint not null default 0,
  entered_on date not null,
  primary key (user_id, fy)
);

-- ===== Reference =====
-- Canonical index registry: the ONE spelling used by etfs.underlying_index,
-- themes.benchmark_index and index_tri.index_name.
create table indices (
  name text primary key,                  -- 'NIFTY INDIA DEFENCE TRI'
  tri_source text not null default 'niftyindices'
    check (tri_source in ('niftyindices','nav_proxy','manual','none')),
    -- 'none' = underlying-only row (no TRI series expected)
  notes text
);

create table themes (
  key text primary key,
  name text not null,
  investable boolean not null default true,
  proxy_note text,
  benchmark_index text references indices(name),
  check (not investable or benchmark_index is not null)
);

create table etfs (
  id serial primary key,
  isin text unique not null,
  name text not null,
  yahoo_symbol text not null,             -- pinned, never runtime-resolved
  amfi_scheme_code text,
  underlying_index text not null references indices(name),
  asset_class text not null check (asset_class in ('equity','gold','silver','debt','intl')),
  intl boolean not null default false,
  check (intl = (asset_class = 'intl')),
  ltcg_months int,                        -- per-instrument OVERRIDE only; null = tax_config rules
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

-- nav_proxy benchmark series = NAV series of ONE pinned ETF (docs/03 §6; seed order:
-- nav_proxy index rows are inserted AFTER their proxy ETF).
alter table indices add column proxy_etf_id int references etfs(id);
alter table indices add constraint indices_proxy_chk
  check (tri_source <> 'nav_proxy' or proxy_etf_id is not null);

create table nse_holidays (
  d date primary key,
  label text
);

-- ===== Time series (EOD) =====
create table etf_prices (
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

create table etf_metrics (
  etf_id int references etfs(id),
  as_of date not null,
  aum_cr numeric(12,2),
  ter_pct numeric(6,3),
  tracking_error_1y numeric(8,4),
  tracking_diff_1y numeric(8,4),
  tracking_diff_3y numeric(8,4),
  tracking_diff_5y numeric(8,4),
  adtv_paise bigint,
  premium_discount_30d numeric(8,4),
  source text not null default 'manual',
  primary key (etf_id, as_of)
);

-- Rows failing ingestion sanity gates are quarantined here, never upserted (docs/09 §5).
create table ingest_quarantine (
  id bigserial primary key,
  job text not null,
  natural_key text not null,
  raw jsonb not null,
  reason text not null,
  resolved boolean not null default false,
  created_at timestamptz default now()
);

-- ===== Config (effective-dated; resolution rule in docs/04 §1) =====
create table tax_config (
  id serial primary key,
  asset_class text not null,
  effective_from date not null,           -- sell-date range
  effective_to date,
  acquired_from date,                     -- buy-date range (null = open) — transition rules
  acquired_to date,
  stcg_mode text not null check (stcg_mode in ('flat','slab')),
  stcg_rate_pct numeric(5,2),
  ltcg_months int not null,
  ltcg_rate_pct numeric(5,2) not null,
  ltcg_exemption_paise bigint not null default 0,
  cess_pct numeric(5,2) not null default 4.0
);

create table charges_config (
  broker_profile text not null,
  charge_key text not null,               -- 'brokerage','stt_sell','stamp_buy','txn','sebi','dp_sell_flat','gst'
  asset_class text not null default 'equity',
  side text not null check (side in ('buy','sell','both')),
  kind text not null check (kind in ('pct','flat_paise')),
  value numeric(12,6) not null,           -- pct rows: value is in PERCENT (0.001 = 0.001%)
  tax_deductible boolean not null default true,  -- STT rows: false (s.48 proviso)
  effective_from date not null,
  effective_to date,
  primary key (broker_profile, charge_key, asset_class, effective_from)
);
-- GST convention: the 'gst' row's pct applies to the SUM of the unrounded
-- brokerage + txn + sebi bases of the same order (docs/04 §3, docs/08 §6).

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

-- ===== User data =====
create table transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  etf_id int not null references etfs(id),
  side text not null check (side in ('buy','sell')),
  qty int not null check (qty > 0),
  price_paise bigint not null,
  charges_paise bigint not null default 0,   -- informational; tax recomputes from config (docs/04 §3)
  traded_on date not null,
  source text not null default 'manual'
    check (source in ('manual','plan','csv','broker')),
  run_id uuid,                               -- FK added after monthly_runs
  created_at timestamptz default now()
);
create index transactions_user_etf_traded_idx on transactions (user_id, etf_id, traded_on);
-- Oversell guard is APP-PATH enforced (engine validation on insert/edit/delete + CSV import);
-- no DB trigger (docs/05 note, accepted for v1).

create view holdings
  with (security_invoker = true) as
  -- QTY ONLY: avg cost / invested / P&L are computed exclusively by the engine's FIFO lot walk.
  select user_id, etf_id,
         sum(case when side = 'buy' then qty else -qty end) as qty
  from transactions
  group by user_id, etf_id
  having sum(case when side = 'buy' then qty else -qty end) > 0;

-- ===== Monthly pipeline =====
-- Shared monthly LLM research: one pass per month serves all users.
create table theme_research (
  research_month date primary key,
  payload jsonb not null,
  model text not null,
  forced boolean not null default false,
  created_at timestamptz default now()
);

create table monthly_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users,
  run_month date not null,
  seq int not null default 1,
  amount_paise bigint not null,
  carry_in_paise bigint not null default 0,
  -- carry_in = residual_paise of the most recent DONE, non-superseded run with an earlier
  -- (run_month, seq); failed/superseded runs are skipped (docs/03 §4 step 5).
  residual_paise bigint,
  research_month date references theme_research(research_month),
  status text not null default 'pending'
    check (status in ('pending','research','gated','theme_ranked','etf_ranked',
                      'allocated','narrated','done','failed','superseded')),
  fail_reason text,
  stage_started_at timestamptz,           -- driver lease, claimed via CAS (docs/10 §3)
  stage_updated_at timestamptz,           -- completion audit stamp
  stage_attempts int not null default 0,
  next_check_at timestamptz,              -- ingest-precondition wait (docs/10 §2)
  llm_cost_usd numeric(8,4) not null default 0,
  created_at timestamptz default now(),
  unique (user_id, run_month, seq)
);

alter table transactions
  add constraint transactions_run_fk foreign key (run_id) references monthly_runs(id);

-- User acknowledgement of plans; kept out of monthly_runs (RLS cannot column-scope — docs/09 §2.3).
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
  factor_json jsonb not null,
  narrative text,                         -- plain text only (docs/09 §8)
  alloc_paise bigint,
  units int,
  weight_target numeric(6,3),             -- FRACTION of X_spendable (0.075 = 7.5%)
  weight_actual numeric(6,3)
);
-- Idempotent stage re-runs: delete-then-insert per level; duplicates impossible.
create unique index reco_theme_uniq on recommendation_items (run_id, theme_key)
  where level = 'theme';
create unique index reco_etf_uniq on recommendation_items (run_id, theme_key, etf_id)
  where level = 'etf';

create table feedback_scores (
  user_id uuid not null references auth.users,
  scope text not null check (scope in ('theme','etf')),
  ref text not null,
  adj numeric(6,2) not null,              -- POST-DECAY CUMULATIVE as of as_of (docs/03 §5)
  as_of date not null,
  detail jsonb not null,
  primary key (user_id, scope, ref, as_of)
);

create table job_runs (
  id bigserial primary key,
  job text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  ok boolean,
  rows int,
  error text check (char_length(error) <= 500)   -- no payload bodies (docs/09 §5); job_runs is
                                                 -- SELECT-open to all authenticated users, so
                                                 -- truncation is enforced at the DB, not just by
                                                 -- Edge Function convention
);

create table metrics_review_queue (
  etf_id int references etfs(id),
  as_of date not null,
  missing_fields text[] not null,
  resolved boolean not null default false,
  primary key (etf_id, as_of)
);

-- ===== RLS (implements the docs/09 §1 matrix) =====
alter table profiles                enable row level security;
alter table profiles                force row level security;
alter table fy_exemption_inputs     enable row level security;
alter table fy_exemption_inputs     force row level security;
alter table user_charges_overrides  enable row level security;
alter table user_charges_overrides  force row level security;
alter table transactions            enable row level security;
alter table transactions            force row level security;
alter table run_acknowledgements    enable row level security;
alter table run_acknowledgements    force row level security;
alter table monthly_runs            enable row level security;
alter table monthly_runs            force row level security;
alter table theme_research          enable row level security;
alter table theme_research          force row level security;
alter table recommendation_items    enable row level security;
alter table recommendation_items    force row level security;
alter table feedback_scores         enable row level security;
alter table feedback_scores         force row level security;
alter table indices                 enable row level security;
alter table indices                 force row level security;
alter table themes                  enable row level security;
alter table themes                  force row level security;
alter table etfs                    enable row level security;
alter table etfs                    force row level security;
alter table theme_etf_map           enable row level security;
alter table theme_etf_map           force row level security;
alter table nse_holidays            enable row level security;
alter table nse_holidays            force row level security;
alter table etf_prices              enable row level security;
alter table etf_prices              force row level security;
alter table etf_navs                enable row level security;
alter table etf_navs                force row level security;
alter table index_tri               enable row level security;
alter table index_tri               force row level security;
alter table etf_metrics             enable row level security;
alter table etf_metrics             force row level security;
alter table ingest_quarantine       enable row level security;
alter table ingest_quarantine       force row level security;
alter table tax_config              enable row level security;
alter table tax_config              force row level security;
alter table charges_config          enable row level security;
alter table charges_config          force row level security;
alter table job_runs                enable row level security;
alter table job_runs                force row level security;
alter table metrics_review_queue    enable row level security;
alter table metrics_review_queue    force row level security;

-- Owner-scoped full CRUD
create policy own_all on profiles for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on fy_exemption_inputs for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_all on user_charges_overrides for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- transactions: own CRUD; run_id (if set) must reference the user's own run
create policy own_all on transactions for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (run_id is null or exists (
      select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid()))
  );

-- run_acknowledgements: SELECT + INSERT own only; acked run must be own
create policy own_read on run_acknowledgements for select to authenticated
  using (user_id = auth.uid());
create policy own_insert on run_acknowledgements for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid())
  );

-- monthly_runs: SELECT own ONLY (no client writes — docs/09 §2.3)
create policy own_read on monthly_runs for select to authenticated
  using (user_id = auth.uid());

-- feedback_scores: SELECT own ONLY (pipeline-written)
create policy own_read on feedback_scores for select to authenticated
  using (user_id = auth.uid());

-- recommendation_items: SELECT via run-ownership join; no client writes
create policy own_read on recommendation_items for select to authenticated
  using (exists (select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid()));

-- theme_research: global read; no client writes
create policy read_all on theme_research for select to authenticated using (true);

-- Reference / market / config / ops tables: read-only to authenticated
create policy read_all on indices              for select to authenticated using (true);
create policy read_all on themes               for select to authenticated using (true);
create policy read_all on etfs                 for select to authenticated using (true);
create policy read_all on theme_etf_map        for select to authenticated using (true);
create policy read_all on nse_holidays         for select to authenticated using (true);
create policy read_all on etf_prices           for select to authenticated using (true);
create policy read_all on etf_navs             for select to authenticated using (true);
create policy read_all on index_tri            for select to authenticated using (true);
create policy read_all on etf_metrics          for select to authenticated using (true);
create policy read_all on tax_config           for select to authenticated using (true);
create policy read_all on charges_config       for select to authenticated using (true);
create policy read_all on job_runs             for select to authenticated using (true);
create policy read_all on metrics_review_queue for select to authenticated using (true);
create policy read_all on ingest_quarantine    for select to authenticated using (true);

grant select on holdings to authenticated;
