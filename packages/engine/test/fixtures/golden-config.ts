/**
 * Mirrors supabase/migrations/20260723000003_seed_tax_charges.sql EXACTLY (broker_profile
 * 'golden' charges + the tax_config seed) — the docs/04 §4.0 pinned fixture. If that migration
 * ever changes, this fixture must change with it; it is not re-derived at test time.
 */
import type { ChargeConfigRow, TaxConfigRow } from '../../src/types.ts';

export const GOLDEN_TAX_CONFIG: TaxConfigRow[] = [
  {
    assetClass: 'equity', effectiveFrom: '2024-07-23', effectiveTo: null,
    acquiredFrom: null, acquiredTo: null,
    stcgMode: 'flat', stcgRatePct: 20.00, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 12_500_000n, cessPct: 4.0,
  },
  // gold: s.50AA transition (bought & sold within Apr-2023..Mar-2025) — LTCG unreachable (1200mo sentinel)
  {
    assetClass: 'gold', effectiveFrom: '2023-04-01', effectiveTo: '2025-03-31',
    acquiredFrom: '2023-04-01', acquiredTo: '2025-03-31',
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 1200, ltcgRatePct: 0.00,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  // gold: FA2024 regime for pre-Apr-2023 units sold 23-Jul-2024 -> 31-Mar-2025
  {
    assetClass: 'gold', effectiveFrom: '2024-07-23', effectiveTo: '2025-03-31',
    acquiredFrom: null, acquiredTo: '2023-03-31',
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  // gold: current regime, from 01-Apr-2025, any acquisition
  {
    assetClass: 'gold', effectiveFrom: '2025-04-01', effectiveTo: null,
    acquiredFrom: null, acquiredTo: null,
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  {
    assetClass: 'silver', effectiveFrom: '2023-04-01', effectiveTo: '2025-03-31',
    acquiredFrom: '2023-04-01', acquiredTo: '2025-03-31',
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 1200, ltcgRatePct: 0.00,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  {
    assetClass: 'silver', effectiveFrom: '2024-07-23', effectiveTo: '2025-03-31',
    acquiredFrom: null, acquiredTo: '2023-03-31',
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  {
    assetClass: 'silver', effectiveFrom: '2025-04-01', effectiveTo: null,
    acquiredFrom: null, acquiredTo: null,
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  {
    assetClass: 'debt', effectiveFrom: '2023-04-01', effectiveTo: null,
    acquiredFrom: '2023-04-01', acquiredTo: null,
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 1200, ltcgRatePct: 0.00,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
  {
    assetClass: 'intl', effectiveFrom: '2024-07-23', effectiveTo: null,
    acquiredFrom: null, acquiredTo: null,
    stcgMode: 'slab', stcgRatePct: null, ltcgMonths: 12, ltcgRatePct: 12.50,
    ltcgExemptionPaise: 0n, cessPct: 4.0,
  },
];

const ASSET_CLASSES = ['equity', 'gold', 'silver', 'debt', 'intl'] as const;
const COMMON_CHARGES: Array<{ chargeKey: string; side: 'buy' | 'sell' | 'both'; kind: 'pct' | 'flat_paise'; value: number; taxDeductible: boolean }> = [
  { chargeKey: 'brokerage', side: 'both', kind: 'pct', value: 0.0, taxDeductible: true },
  { chargeKey: 'txn', side: 'both', kind: 'pct', value: 0.00297, taxDeductible: true },
  { chargeKey: 'sebi', side: 'both', kind: 'pct', value: 0.0001, taxDeductible: true },
  { chargeKey: 'stamp_buy', side: 'buy', kind: 'pct', value: 0.015, taxDeductible: true },
  { chargeKey: 'gst', side: 'both', kind: 'pct', value: 18.0, taxDeductible: true },
  { chargeKey: 'dp_sell_flat', side: 'sell', kind: 'flat_paise', value: 1593.0, taxDeductible: true },
];

export const GOLDEN_CHARGES_CONFIG: ChargeConfigRow[] = ASSET_CLASSES.flatMap((assetClass) =>
  COMMON_CHARGES.map((c) => ({ ...c, assetClass, effectiveFrom: '2023-04-01', effectiveTo: null }))
).concat([
  { chargeKey: 'stt_sell', assetClass: 'equity', side: 'sell', kind: 'pct', value: 0.001, taxDeductible: false, effectiveFrom: '2023-04-01', effectiveTo: null },
]);
