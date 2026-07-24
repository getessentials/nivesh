-- Seed: tax_config + charges_config (docs/04; FY2025-26 / AY2026-27 state, re-verified vs
-- Budget 2026 on 2026-07-23). Resolution rule: sell_date ∈ [effective_from, effective_to] AND
-- buy_date ∈ [acquired_from, acquired_to]; null = open-ended (docs/04 §1).
--
-- Scope note (documented limitation, not a bug): rows are seeded for sells on/after 23-Jul-2024
-- (equity/intl) and 01-Apr-2023 (gold/silver/debt). Earlier sell dates have no row and the
-- engine must ERROR (never guess) — pre-FA2024 regimes (indexation etc.) are out of v1 scope.
--
-- ltcg_months = 1200 encodes "LTCG unreachable" (slab treatment regardless of holding period).

-- equity (listed, STT-paid): STCG 111A 20%, LTCG 112A 12.5% over ₹1.25L aggregate/FY
insert into tax_config (asset_class, effective_from, effective_to, acquired_from, acquired_to,
                        stcg_mode, stcg_rate_pct, ltcg_months, ltcg_rate_pct,
                        ltcg_exemption_paise, cess_pct) values
  ('equity', '2024-07-23', null, null, null, 'flat', 20.00, 12, 12.50, 12500000, 4.0);

-- gold (listed commodity ETFs)
insert into tax_config (asset_class, effective_from, effective_to, acquired_from, acquired_to,
                        stcg_mode, stcg_rate_pct, ltcg_months, ltcg_rate_pct,
                        ltcg_exemption_paise, cess_pct) values
  -- s.50AA transition: units bought Apr-2023→Mar-2025 AND sold in that window = slab
  -- regardless of holding period (LTCG unreachable)
  ('gold', '2023-04-01', '2025-03-31', '2023-04-01', '2025-03-31',
   'slab', null, 1200, 0.00, 0, 4.0),
  -- FA2024 regime for old (pre-Apr-2023) units sold 23-Jul-2024 → 31-Mar-2025
  ('gold', '2024-07-23', '2025-03-31', null, '2023-03-31',
   'slab', null, 12, 12.50, 0, 4.0),
  -- from 01-Apr-2025: any acquisition — STCG slab ≤12m, LTCG 12.5% >12m, no exemption
  ('gold', '2025-04-01', null, null, null,
   'slab', null, 12, 12.50, 0, 4.0);

-- silver (same 50AA treatment as gold)
insert into tax_config (asset_class, effective_from, effective_to, acquired_from, acquired_to,
                        stcg_mode, stcg_rate_pct, ltcg_months, ltcg_rate_pct,
                        ltcg_exemption_paise, cess_pct) values
  ('silver', '2023-04-01', '2025-03-31', '2023-04-01', '2025-03-31',
   'slab', null, 1200, 0.00, 0, 4.0),
  ('silver', '2024-07-23', '2025-03-31', null, '2023-03-31',
   'slab', null, 12, 12.50, 0, 4.0),
  ('silver', '2025-04-01', null, null, null,
   'slab', null, 12, 12.50, 0, 4.0);

-- debt: bought on/after 01-Apr-2023 — slab always (no LTCG, no indexation)
insert into tax_config (asset_class, effective_from, effective_to, acquired_from, acquired_to,
                        stcg_mode, stcg_rate_pct, ltcg_months, ltcg_rate_pct,
                        ltcg_exemption_paise, cess_pct) values
  ('debt', '2023-04-01', null, '2023-04-01', null,
   'slab', null, 1200, 0.00, 0, 4.0);

-- intl: default LISTED intl ETF = 12m / 12.5%, STCG at slab (no 111A without STT).
-- FoF structures use the per-instrument override etfs.ltcg_months = 24 (docs/04 §2.4,
-- VERIFY-AT-SEED per instrument).
insert into tax_config (asset_class, effective_from, effective_to, acquired_from, acquired_to,
                        stcg_mode, stcg_rate_pct, ltcg_months, ltcg_rate_pct,
                        ltcg_exemption_paise, cess_pct) values
  ('intl', '2024-07-23', null, null, null,
   'slab', null, 12, 12.50, 0, 4.0);

-- ===== charges_config =====
-- Two broker profiles: 'discount_default' (live; VERIFY against the owner's actual broker,
-- docs/07 §13 item 1) and 'golden' (the pinned docs/04 §4.0 test fixture — NEVER update).
-- pct values are in PERCENT (0.001 = 0.001%). STT is tax_deductible = false (s.48 proviso).
-- STT 0.001% is the delivery-side ETF rate (intraday would be 0.025% — out of scope).
insert into charges_config (broker_profile, charge_key, asset_class, side, kind, value,
                            tax_deductible, effective_from, effective_to)
select p.profile, c.charge_key, a.asset_class, c.side, c.kind, c.value, c.tax_deductible,
       date '2023-04-01', null
from (values ('discount_default'), ('golden')) as p(profile)
cross join (values ('equity'), ('gold'), ('silver'), ('debt'), ('intl')) as a(asset_class)
cross join (values
  ('brokerage',    'both', 'pct',        0.0::numeric,      true),
  ('txn',          'both', 'pct',        0.00297::numeric,  true),
  ('sebi',         'both', 'pct',        0.0001::numeric,   true),
  ('stamp_buy',    'buy',  'pct',        0.015::numeric,    true),
  ('gst',          'both', 'pct',        18.0::numeric,     true),
  ('dp_sell_flat', 'sell', 'flat_paise', 1593.0::numeric,   true)
) as c(charge_key, side, kind, value, tax_deductible);

-- STT: equity only, sell side, NOT deductible
insert into charges_config (broker_profile, charge_key, asset_class, side, kind, value,
                            tax_deductible, effective_from, effective_to) values
  ('discount_default', 'stt_sell', 'equity', 'sell', 'pct', 0.001, false, '2023-04-01', null),
  ('golden',           'stt_sell', 'equity', 'sell', 'pct', 0.001, false, '2023-04-01', null);
