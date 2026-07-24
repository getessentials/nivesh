import { describe, expect, it } from 'vitest';
import { resolveChargeRows } from '../src/config-resolution.ts';
import { computeLegCharges } from '../src/charges.ts';
import { GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';

describe('computeLegCharges — reproduces docs/04 E1 end-to-end via real config resolution', () => {
  const rows = resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'equity', '2026-01-05');

  it('buy leg: 100 units @ Rs.250 -> 466 paise total charges', () => {
    const buy = computeLegCharges(rows, 'buy', 2_500_000n);
    expect(buy.totalPaise).toBe(466n);
    expect(buy.deductiblePaise).toBe(466n); // nothing non-deductible on the buy side
    const byKey = Object.fromEntries(buy.lineItems.map((li) => [li.chargeKey, li.amountPaise]));
    expect(byKey.txn).toBe(74n);
    expect(byKey.sebi).toBe(3n);
    expect(byKey.stamp_buy).toBe(375n);
    expect(byKey.gst).toBe(14n);
    expect(byKey.brokerage).toBe(0n);
  });

  it('sell leg: 100 units @ Rs.310 -> 1,736 paise total, 1,705 paise deductible', () => {
    const sell = computeLegCharges(rows, 'sell', 3_100_000n);
    expect(sell.totalPaise).toBe(1736n);
    expect(sell.deductiblePaise).toBe(1705n); // STT (31) excluded
    const byKey = Object.fromEntries(sell.lineItems.map((li) => [li.chargeKey, li.amountPaise]));
    expect(byKey.stt_sell).toBe(31n);
    expect(byKey.txn).toBe(92n);
    expect(byKey.sebi).toBe(3n);
    expect(byKey.gst).toBe(17n);
    expect(byKey.dp_sell_flat).toBe(1593n);
  });

  it('sell leg has no stamp_buy line item (buy-only charge)', () => {
    const sell = computeLegCharges(rows, 'sell', 3_100_000n);
    expect(sell.lineItems.some((li) => li.chargeKey === 'stamp_buy')).toBe(false);
  });

  it('buy leg has no STT or DP line items (sell-only charges)', () => {
    const buy = computeLegCharges(rows, 'buy', 2_500_000n);
    expect(buy.lineItems.some((li) => li.chargeKey === 'stt_sell' || li.chargeKey === 'dp_sell_flat')).toBe(false);
  });
});

describe('computeLegCharges — gold (no STT, no stamp_buy exclusion difference)', () => {
  it('gold sell leg has no STT line item at all', () => {
    const rows = resolveChargeRows(GOLDEN_CHARGES_CONFIG, 'gold', '2026-01-05');
    const sell = computeLegCharges(rows, 'sell', 1_000_000n);
    expect(sell.lineItems.some((li) => li.chargeKey === 'stt_sell')).toBe(false);
  });
});
