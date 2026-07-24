-- Per-run ETF eligibility gate results (docs/03 §2.2/§3.1, docs/01 §4 screen 3: "Excluded-ETF
-- list with reasons"). Not anticipated in the original docs/05 schema — the ranking stages need
-- somewhere to hand off gate results to each other (each pipeline stage is a separate Edge
-- Function invocation with no shared memory, docs/10 §3), and the plan card needs to show WHY an
-- ETF was excluded, which the deterministic gates alone (packages/engine/gates.ts) don't persist
-- anywhere on their own. Theme-level investability-this-run is deliberately NOT a separate table:
-- it's derived by joining this table through theme_etf_map (a theme is eligible iff >=1 of its
-- mapped ETFs has eligible=true here), so the two concepts can never silently disagree.
create table run_etf_gate_results (
  run_id uuid not null references monthly_runs(id),
  etf_id int not null references etfs(id),
  -- an ETF can map to more than one theme (theme_etf_map); gate outcomes are evaluated per
  -- (theme cohort, ETF) pair since some gates are peer-relative within a cohort (docs/03 §3.1 G4).
  theme_key text not null references themes(key),
  eligible boolean not null,
  failure_reasons text[] not null default '{}',
  primary key (run_id, etf_id, theme_key)
);

alter table run_etf_gate_results enable row level security;
alter table run_etf_gate_results force row level security;

-- Same run-ownership SELECT pattern as recommendation_items (docs/09 §1); pipeline-only writes.
create policy own_read on run_etf_gate_results for select
  using (exists (select 1 from monthly_runs r where r.id = run_id and r.user_id = auth.uid()));
