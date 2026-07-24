import { describe, expect, it } from 'vitest';
import { computeRemainingLots } from '../src/fifo.ts';
import { computeFySellSequence, type FySellEvent } from '../src/tax.ts';
import { GOLDEN_TAX_CONFIG, GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';
import type { Transaction } from '../src/types.ts';

function txn(id: string, side: 'buy' | 'sell', qty: number, price: number, tradedOn: string): Transaction {
  return { id, side, qty, pricePaise: BigInt(price), tradedOn, createdAt: tradedOn };
}

describe('computeFySellSequence (docs/04 §2.1: exemption consumed chronologically across sells in one FY)', () => {
  it('threads the exemption ledger between two separate sells, later sells seeing what earlier ones consumed', () => {
    // Two independent 100-unit equity lots, both held >12 months by the sell dates, sold on two
    // different dates within the same FY. Both slices have identical taxable gain (597,829 paise,
    // same as E1/E2's numbers) so the second sell's exemption consumption is easy to predict.
    const lotsA = computeRemainingLots([txn('bA', 'buy', 100, 25000, '2024-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);
    const lotsB = computeRemainingLots([txn('bB', 'buy', 100, 25000, '2024-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);

    const baseRequest = {
      assetClass: 'equity' as const, ltcgMonthsOverride: null,
      sellPricePaise: 31000n, sellQty: 100,
      taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
      slabPct: 30,
    };

    const events: FySellEvent[] = [
      { id: 'sB', createdAt: '2026-06-01', request: { ...baseRequest, sellDate: '2026-06-01', currentLots: lotsB, exemptionRemainingPaise: 0n } },
      { id: 'sA', createdAt: '2026-05-01', request: { ...baseRequest, sellDate: '2026-05-01', currentLots: lotsA, exemptionRemainingPaise: 0n } },
    ];

    // Exemption available for the whole FY: exactly enough to cover ONE sell's gain (597,829)
    // plus a little, but not both (2 x 597,829 = 1,195,658).
    const results = computeFySellSequence(events, 700_000n);

    // sA (sellDate 2026-05-01) must be processed FIRST despite appearing second in the input
    // array — sorted by sellDate, not array order.
    expect(results[0]!.exemptionConsumedPaise).toBe(597_829n); // sA: fully covered by the 700,000 available
    // sB (2026-06-01) only has 700,000 - 597,829 = 102,171 left -> partially covered
    expect(results[1]!.exemptionConsumedPaise).toBe(102_171n);
    expect(results[1]!.slices[0]!.taxWithCessPaise).toBeGreaterThan(0n); // the uncovered remainder IS taxed
  });

  it('same-day sells tie-break by createdAt, then id (docs/04 §2.1)', () => {
    const lotsA = computeRemainingLots([txn('bA', 'buy', 100, 25000, '2024-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);
    const lotsB = computeRemainingLots([txn('bB', 'buy', 100, 25000, '2024-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);
    const baseRequest = {
      assetClass: 'equity' as const, ltcgMonthsOverride: null,
      sellPricePaise: 31000n, sellQty: 100, sellDate: '2026-06-01',
      taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
      slabPct: 30, exemptionRemainingPaise: 0n,
    };
    const events: FySellEvent[] = [
      { id: 'sZ', createdAt: '2026-06-01T09:00:00Z', request: { ...baseRequest, currentLots: lotsB } }, // later createdAt
      { id: 'sA', createdAt: '2026-06-01T08:00:00Z', request: { ...baseRequest, currentLots: lotsA } }, // earlier createdAt -> processed first
    ];
    // Exemption covers exactly one sell's gain; the FIRST-PROCESSED one (by createdAt) should
    // get it, not the one appearing first in the input array.
    const results = computeFySellSequence(events, 597_829n);
    expect(results[0]!.exemptionConsumedPaise).toBe(597_829n); // sA (earlier createdAt) got the exemption
    expect(results[1]!.exemptionConsumedPaise).toBe(0n); // sZ got none left
  });

  it('the total exemption consumed across the sequence never exceeds what was available', () => {
    const lotsA = computeRemainingLots([txn('bA', 'buy', 200, 25000, '2024-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);
    const baseRequest = {
      assetClass: 'equity' as const, ltcgMonthsOverride: null,
      sellPricePaise: 31000n, taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
      slabPct: 30, exemptionRemainingPaise: 0n,
    };
    const events: FySellEvent[] = [
      { id: 's1', createdAt: '2026-05-01', request: { ...baseRequest, sellDate: '2026-05-01', sellQty: 100, currentLots: lotsA } },
      { id: 's2', createdAt: '2026-06-01', request: { ...baseRequest, sellDate: '2026-06-01', sellQty: 100, currentLots: computeRemainingLots([txn('bA', 'buy', 200, 25000, '2024-01-05'), txn('s1', 'sell', 100, 31000, '2026-05-01')], 'equity', GOLDEN_CHARGES_CONFIG) } },
    ];
    const results = computeFySellSequence(events, 800_000n);
    const totalConsumed = results.reduce((s, r) => s + r.exemptionConsumedPaise, 0n);
    expect(totalConsumed).toBeLessThanOrEqual(800_000n);
  });
});
