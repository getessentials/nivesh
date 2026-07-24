-- Any-day pricing (docs/03 header, CLAUDE.md): the pricing/data date a run actually used, resolved
-- once by stage-research (resolveReadyRunDate — most recent trading day with full price/NAV/TRI
-- coverage, not a fixed "first trading day of month" target) and persisted here so every
-- downstream stage reads the SAME date instead of each independently recomputing
-- firstTradingDayOfMonth(run_month) — which would silently drift out of sync with what
-- stage-research actually validated data for if the pipeline spans multiple days.
alter table monthly_runs add column run_date date;
