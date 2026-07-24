import { describe, expect, it } from 'vitest';
import { resolveTaxConfig, resolveChargeRows } from '../src/config-resolution.ts';
import { GOLDEN_TAX_CONFIG, GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';

describe('resolveTaxConfig — matches the schema-test probes from build step 1', () => {
  it('equity resolves to the single row', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'equity', '2026-02-20', '2026-01-05');
    expect(row.stcgRatePct).toBe(20.00);
    expect(row.ltcgExemptionPaise).toBe(12_500_000n);
  });

  it('gold: s.50AA transition row (sold and bought within Apr-2023..Mar-2025)', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'gold', '2024-11-01', '2023-06-01');
    expect(row.ltcgMonths).toBe(1200); // LTCG unreachable sentinel
  });

  it('gold: FA2024 old-units row (bought before Apr-2023, sold in the FA2024 window)', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'gold', '2024-11-01', '2022-06-01');
    expect(row.ltcgMonths).toBe(12);
    expect(row.ltcgRatePct).toBe(12.50);
  });

  it('gold: current regime row (sold after Apr-2025)', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'gold', '2026-07-01', '2024-06-01');
    expect(row.ltcgMonths).toBe(12);
  });

  it('debt resolves to the single slab-always row', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'debt', '2026-07-01', '2024-01-01');
    expect(row.stcgMode).toBe('slab');
    expect(row.ltcgMonths).toBe(1200);
  });

  it('intl resolves to the single row', () => {
    const row = resolveTaxConfig(GOLDEN_TAX_CONFIG, 'intl', '2026-07-01', '2025-01-01');
    expect(row.ltcgMonths).toBe(12);
  });

  it('throws (never guesses) when no row resolves — a pre-FA2024 sell date', () => {
    expect(() => resolveTaxConfig(GOLDEN_TAX_CONFIG, 'equity', '2023-01-01', '2022-01-01')).toThrow();
  });

  it('throws on an ambiguous (overlapping) config rather than picking one silently', () => {
    const overlapping = [...GOLDEN_TAX_CONFIG, { ...GOLDEN_TAX_CONFIG[0]! }]; // duplicate the equity row
    expect(() => resolveTaxConfig(overlapping, 'equity', '2026-02-20', '2026-01-05')).toThrow(/ambiguous/);
  });
});

describe('resolveChargeRows', () => {
  it('returns exactly one row per charge_key for equity', () => {
    const rows = resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'equity', '2026-07-01');
    const keys = rows.map((r) => r.chargeKey).sort();
    expect(keys).toEqual(['brokerage', 'dp_sell_flat', 'gst', 'sebi', 'stamp_buy', 'stt_sell', 'txn']);
  });

  it('gold has no stt_sell row at all', () => {
    const rows = resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'gold', '2026-07-01');
    expect(rows.some((r) => r.chargeKey === 'stt_sell')).toBe(false);
  });

  it('a user override replaces the broker-profile row for the same charge_key', () => {
    const override = { chargeKey: 'txn', assetClass: 'equity' as const, side: 'both' as const, kind: 'pct' as const, value: 0.001, taxDeductible: true, effectiveFrom: '2023-04-01', effectiveTo: null };
    const rows = resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'equity', '2026-07-01', [override]);
    const txn = rows.find((r) => r.chargeKey === 'txn');
    expect(txn?.value).toBe(0.001);
  });

  it('throws (never silently charges nothing) when the config has ZERO rows for the asset class/date — a seed gap, not a legitimate zero-charge class', () => {
    expect(() => resolveChargeRows([], 'equity', '2026-07-01')).toThrow(/no charges_config rows resolve at all/);
    // also a date entirely outside every row's effective range (all rows expired/not-yet-effective)
    expect(() => resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'equity', '2020-01-01')).toThrow(/no charges_config rows resolve at all/);
  });
});
