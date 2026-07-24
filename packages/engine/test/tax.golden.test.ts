/**
 * Golden tests reproducing docs/04 §4 worked examples E1-E4 to the paisa, against the exact
 * pinned fixture (docs/04 §4.0 / test/fixtures/golden-config.ts).
 */
import { describe, expect, it } from 'vitest';
import { computeRemainingLots } from '../src/fifo.ts';
import { computeSellPlan, taxWithCess } from '../src/tax.ts';
import { GOLDEN_TAX_CONFIG, GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';
import type { Transaction } from '../src/types.ts';

function txn(id: string, side: 'buy' | 'sell', qty: number, price: number, tradedOn: string): Transaction {
  return { id, side, qty, pricePaise: BigInt(price), tradedOn, createdAt: tradedOn };
}

describe('E1 — equity STCG, 100 units @ Rs.250 -> sell @ Rs.310 after 46 days', () => {
  const lots = computeRemainingLots([txn('b1', 'buy', 100, 25000, '2026-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);

  const result = computeSellPlan({
    assetClass: 'equity', ltcgMonthsOverride: null,
    sellDate: '2026-02-20', sellPricePaise: 31000n, sellQty: 100,
    currentLots: lots, taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
    slabPct: 30, exemptionRemainingPaise: 12_500_000n,
  });

  it('classifies as STCG (46 days, well under 12 months)', () => {
    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.classification).toBe('STCG');
  });

  it('reproduces every charge line to the paisa', () => {
    const s = result.slices[0]!;
    expect(s.buyDeductibleChargesPaise).toBe(466n);
    expect(s.sellChargesPaise).toBe(1736n);
    expect(s.sellDeductibleChargesPaise).toBe(1705n);
    expect(s.effectiveCostPaise).toBe(2_500_466n);
  });

  it('taxable gain = 597,829 paise', () => {
    expect(result.slices[0]!.taxableGainPaise).toBe(597_829n);
  });

  it('tax+cess = 124,348 paise (597,829 x 0.20 x 1.04 = 124,348.432 -> 124,348)', () => {
    expect(result.slices[0]!.taxWithCessPaise).toBe(124_348n);
    expect(result.totalTaxWithCessPaise).toBe(124_348n);
  });

  it('net proceeds = 2,973,916 paise', () => {
    expect(result.slices[0]!.netProceedsPaise).toBe(2_973_916n);
    expect(result.totalNetProceedsPaise).toBe(2_973_916n);
  });

  it('consumes no LTCG exemption (this is a STCG slice)', () => {
    expect(result.exemptionConsumedPaise).toBe(0n);
  });
});

describe('E2 — same buy, sold after >12 months: LTCG under the exemption -> zero tax', () => {
  const lots = computeRemainingLots([txn('b1', 'buy', 100, 25000, '2026-01-05')], 'equity', GOLDEN_CHARGES_CONFIG);

  const result = computeSellPlan({
    assetClass: 'equity', ltcgMonthsOverride: null,
    sellDate: '2027-02-10', sellPricePaise: 31000n, sellQty: 100,
    currentLots: lots, taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
    slabPct: 30, exemptionRemainingPaise: 12_500_000n, // full exemption available, no external usage
  });

  it('classifies as LTCG (13 months held)', () => {
    expect(result.slices[0]!.classification).toBe('LTCG');
    expect(result.slices[0]!.monthsHeld).toBe(13);
  });

  it('same taxable gain as E1 (597,829) but fully covered by the exemption -> zero tax', () => {
    expect(result.slices[0]!.taxableGainPaise).toBe(597_829n);
    expect(result.slices[0]!.taxWithCessPaise).toBe(0n);
    expect(result.totalTaxWithCessPaise).toBe(0n);
  });

  it('exemption ledger records exactly 597,829 paise consumed', () => {
    expect(result.exemptionConsumedPaise).toBe(597_829n);
  });

  it('net proceeds = 3,098,264 paise (no tax, only sell charges deducted)', () => {
    expect(result.totalNetProceedsPaise).toBe(3_098_264n);
  });
});

describe('E3 — gold, taxable gain 4,000,000 paise in 8 months, slab 30%', () => {
  it('tax+cess = 1,248,000 paise exactly', () => {
    expect(taxWithCess(4_000_000n, 30, 4)).toBe(1_248_000n);
  });

  it('reproduces via a full gold sell-plan too (no STT in the gold charges stack)', () => {
    // Construct a gold buy/sell that is charge-neutral-ish is hard to hand-pick exactly to
    // 4,000,000 taxable gain; the authoritative E3 check is taxWithCess above (which is what
    // docs/04 E3 itself specifies: "taxable gain (already charge-adjusted)"). This test only
    // sanity-checks that a gold sell plan has zero exemption consumption and no STT line item.
    const lots = computeRemainingLots([txn('b1', 'buy', 500, 10000, '2025-11-01')], 'gold', GOLDEN_CHARGES_CONFIG);
    const result = computeSellPlan({
      assetClass: 'gold', ltcgMonthsOverride: null,
      sellDate: '2026-07-01', sellPricePaise: 18000n, sellQty: 500,
      currentLots: lots, taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
      slabPct: 30, exemptionRemainingPaise: 0n,
    });
    expect(result.slices[0]!.classification).toBe('STCG'); // 8 months < 12
    expect(result.exemptionConsumedPaise).toBe(0n); // gold config has ltcgExemptionPaise=0 anyway
    // single slice -> no apportionment ambiguity, its charges equal the whole order's exactly
    expect(result.slices[0]!.sellChargesPaise).toBe(result.totalSellChargesPaise);
    expect(result.slices[0]!.sellChargesPaise).not.toBe(0n); // sanity: charges were actually computed
  });
});

describe('E4 — FIFO across two lots (100 LTCG @ 14mo + 50 STCG @ 3mo), one sell, apportioned charges', () => {
  const lots = computeRemainingLots([
    txn('b1', 'buy', 100, 25000, '2025-05-01'), // 14 months before the 2026-07-01 sell
    txn('b2', 'buy', 100, 28000, '2026-04-01'), // 3 months before the sell
  ], 'equity', GOLDEN_CHARGES_CONFIG);

  const result = computeSellPlan({
    assetClass: 'equity', ltcgMonthsOverride: null,
    sellDate: '2026-07-01', sellPricePaise: 31000n, sellQty: 150,
    currentLots: lots, taxConfigs: GOLDEN_TAX_CONFIG, brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
    slabPct: 30, exemptionRemainingPaise: 12_500_000n,
  });

  it('FIFO splits into 100 LTCG (lot1) + 50 STCG (lot2)', () => {
    expect(result.slices).toHaveLength(2);
    expect(result.slices[0]).toMatchObject({ lotId: 'b1', qty: 100, classification: 'LTCG', monthsHeld: 14 });
    expect(result.slices[1]).toMatchObject({ lotId: 'b2', qty: 50, classification: 'STCG', monthsHeld: 3 });
  });

  it('each slice carries its lot\'s real buy charges, apportioned by qty for the partial lot', () => {
    // lot1 sold in full (100 of 100) -> its full original 466 paise, no rounding drift
    expect(result.slices[0]!.buyDeductibleChargesPaise).toBe(466n);
    // lot2 half-sold (50 of 100, original deductible charges 521) -> apportioned, not recomputed
    expect(result.slices[1]!.buyDeductibleChargesPaise).toBe(261n); // divRoundHalfUp(521*50, 100)
  });

  it('ONE charges pass on the single 150-unit sell: per-slice sell charges sum EXACTLY to the order total', () => {
    const sumPerSlice = result.slices.reduce((s, x) => s + x.sellChargesPaise, 0n);
    expect(sumPerSlice).toBe(result.totalSellChargesPaise);
  });

  it('per-slice deductible sell charges also sum exactly to the order deductible total', () => {
    // total sell consideration 150*31000=4,650,000; charges: stt 47 + txn 138 + sebi 5 + gst 26 + dp 1593 = 1809
    expect(result.totalSellChargesPaise).toBe(1809n);
    const sumDeductible = result.slices.reduce((s, x) => s + x.sellDeductibleChargesPaise, 0n);
    expect(sumDeductible).toBe(1809n - 47n); // minus non-deductible STT
  });

  it('the 100-unit LTCG slice consumes the exemption ledger; the 50-unit STCG slice does not', () => {
    expect(result.slices[1]!.exemptionUsedPaise).toBe(0n);
    expect(result.exemptionConsumedPaise).toBe(result.slices[0]!.exemptionUsedPaise);
  });

  it('total net proceeds equal the sum of per-slice net proceeds (no leftover paisa anywhere)', () => {
    const sumProceeds = result.slices.reduce((s, x) => s + x.netProceedsPaise, 0n);
    expect(sumProceeds).toBe(result.totalNetProceedsPaise);
  });
});
