/**
 * E5 has no pre-computed golden numbers in docs/04 (unlike E1-E4) — the doc specifies the
 * ALGORITHM and explicitly frames P* as an unrounded-float approximation. So the right test is
 * self-consistency: recompute net_later independently at the solved P* and confirm it equals
 * net_now (the defining equation), plus sanity on direction and the kink logic.
 */
import { describe, expect, it } from 'vitest';
import { computeRotationBreakeven } from '../src/breakeven.ts';
import { GOLDEN_CHARGES_CONFIG } from './fixtures/golden-config.ts';

// Independent re-implementation of net_later(P), NOT sharing code with breakeven.ts, so this
// genuinely cross-checks the solver rather than checking its own arithmetic against itself.
function independentNetLater(P: number, qty: number, effectiveCost: number, ltcgRatePct: number, cessPct: number, exemptionRemaining: number): number {
  const considerationPaise = qty * P;
  // golden equity sell charges, replicated by hand from the same config values used elsewhere:
  const stt = considerationPaise * 0.00001;
  const txn = considerationPaise * 0.0000297;
  const sebi = considerationPaise * 0.000001;
  const gst = 0.18 * (txn + sebi);
  const dp = 1593;
  const totalCharges = stt + txn + sebi + gst + dp;
  const deductibleCharges = txn + sebi + gst + dp; // stt excluded
  const gain = considerationPaise - deductibleCharges - effectiveCost;
  const taxableAfterExemption = Math.max(0, gain - exemptionRemaining);
  const tax = taxableAfterExemption * (ltcgRatePct / 100) * (1 + cessPct / 100);
  return considerationPaise - totalCharges - tax;
}

describe('computeRotationBreakeven — E5 self-consistency', () => {
  const base = {
    assetClass: 'equity' as const,
    qty: 100,
    currentPricePaise: 31000n, // Rs.310 (E1's sell price)
    effectiveCostPaise: 2_500_466n, // E1's exact effective cost
    stcgRatePct: 20, ltcgRatePct: 12.5, cessPct: 4,
    sellDate: '2026-07-01',
    brokerChargeConfigs: GOLDEN_CHARGES_CONFIG,
  };

  it('with ample remaining exemption, the solved P* satisfies net_later(P*) = net_now to within a paisa', () => {
    const result = computeRotationBreakeven({ ...base, exemptionRemainingPaise: 12_500_000n });
    const netLaterAtPStar = independentNetLater(
      result.breakevenPricePaise, base.qty, Number(base.effectiveCostPaise),
      base.ltcgRatePct, base.cessPct, 12_500_000
    );
    expect(Math.abs(netLaterAtPStar - Number(result.netNowPaise))).toBeLessThan(1);
  });

  it('with exemption already exhausted, the solver still converges (segment 2 of the kink)', () => {
    const result = computeRotationBreakeven({ ...base, exemptionRemainingPaise: 0n });
    const netLaterAtPStar = independentNetLater(
      result.breakevenPricePaise, base.qty, Number(base.effectiveCostPaise),
      base.ltcgRatePct, base.cessPct, 0
    );
    expect(Math.abs(netLaterAtPStar - Number(result.netNowPaise))).toBeLessThan(1);
  });

  it('net_now matches an independently computed STCG net (docs/04 E1 numbers, same inputs)', () => {
    const result = computeRotationBreakeven({ ...base, exemptionRemainingPaise: 12_500_000n });
    // E1 used exactly this qty/price/effectiveCost/stcgRate/cess -> net proceeds 2,973,916 paise
    expect(Number(result.netNowPaise)).toBeCloseTo(2_973_916, -1); // within a few paise (float vs exact-paisa E1)
    expect(Number(result.taxIfNowPaise)).toBeCloseTo(124_348, -1);
  });

  it('a higher current price (larger gain) raises the STCG tax paid now', () => {
    const low = computeRotationBreakeven({ ...base, currentPricePaise: 26000n, exemptionRemainingPaise: 12_500_000n });
    const high = computeRotationBreakeven({ ...base, currentPricePaise: 40000n, exemptionRemainingPaise: 12_500_000n });
    expect(high.taxIfNowPaise).toBeGreaterThan(low.taxIfNowPaise);
  });

  it('dropFraction is consistent with (P0 - P*) / P0', () => {
    const result = computeRotationBreakeven({ ...base, exemptionRemainingPaise: 12_500_000n });
    const expected = (31000 - result.breakevenPricePaise) / 31000;
    expect(result.dropFraction).toBeCloseTo(expected, 10);
  });
});
