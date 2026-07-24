import { describe, expect, it } from 'vitest';
import { chargeFromPct, divRoundHalfUp, gstOnUnroundedBases, apportionLargestRemainder } from '../src/rounding.ts';

describe('divRoundHalfUp', () => {
  it('rounds exact halves up', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n); // 0.5 -> 1
    expect(divRoundHalfUp(5n, 2n)).toBe(3n); // 2.5 -> 3
  });
  it('rounds below/above half correctly', () => {
    expect(divRoundHalfUp(9n, 10n)).toBe(1n); // 0.9 -> 1
    expect(divRoundHalfUp(4n, 10n)).toBe(0n); // 0.4 -> 0
  });
  it('handles negatives symmetrically', () => {
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
  });
});

describe('chargeFromPct — reproduces docs/04 E1 buy-side charges exactly', () => {
  const buyConsideration = 2_500_000n; // 100 units @ Rs.250

  it('txn 0.00297% of 2,500,000 -> 74.25 -> 74', () => {
    expect(chargeFromPct(buyConsideration, 0.00297)).toBe(74n);
  });
  it('sebi 0.0001% of 2,500,000 -> 2.5 -> 3 (exact half rounds up)', () => {
    expect(chargeFromPct(buyConsideration, 0.0001)).toBe(3n);
  });
  it('stamp 0.015% of 2,500,000 -> 375 exactly', () => {
    expect(chargeFromPct(buyConsideration, 0.015)).toBe(375n);
  });
});

describe('chargeFromPct — reproduces docs/04 E1 sell-side charges exactly', () => {
  const sellConsideration = 3_100_000n; // 100 units @ Rs.310

  it('stt 0.001% of 3,100,000 -> 31 exactly', () => {
    expect(chargeFromPct(sellConsideration, 0.001)).toBe(31n);
  });
  it('txn 0.00297% of 3,100,000 -> 92.07 -> 92', () => {
    expect(chargeFromPct(sellConsideration, 0.00297)).toBe(92n);
  });
  it('sebi 0.0001% of 3,100,000 -> 3.1 -> 3', () => {
    expect(chargeFromPct(sellConsideration, 0.0001)).toBe(3n);
  });
});

describe('gstOnUnroundedBases — reproduces docs/04 E1 GST lines exactly', () => {
  it('buy side: 18% of (brokerage=0 + txn=74.25 + sebi=2.5) = 13.815 -> 14', () => {
    const gst = gstOnUnroundedBases(
      [
        { basePaise: 2_500_000n, pctPercent: 0 }, // brokerage
        { basePaise: 2_500_000n, pctPercent: 0.00297 }, // txn
        { basePaise: 2_500_000n, pctPercent: 0.0001 }, // sebi
      ],
      18
    );
    expect(gst).toBe(14n);
  });

  it('sell side: 18% of (brokerage=0 + txn=92.07 + sebi=3.1) = 17.1306 -> 17', () => {
    const gst = gstOnUnroundedBases(
      [
        { basePaise: 3_100_000n, pctPercent: 0 },
        { basePaise: 3_100_000n, pctPercent: 0.00297 },
        { basePaise: 3_100_000n, pctPercent: 0.0001 },
      ],
      18
    );
    expect(gst).toBe(17n);
  });
});

describe('apportionLargestRemainder', () => {
  it('splits an amount exactly across equal weights, summing to the total', () => {
    const shares = apportionLargestRemainder(100n, [1n, 1n, 1n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(shares.every((s) => s === 33n || s === 34n)).toBe(true);
  });

  it('gives the leftover unit(s) to the largest remainder, ties to the earlier index', () => {
    // total=10, weights=[1,1,1] -> each floor(10/3)=3, remainder 1 left over, all three tie
    // (10*1 - 3*3 = 1 for each) -> earliest index (0) gets it.
    const shares = apportionLargestRemainder(10n, [1n, 1n, 1n]);
    expect(shares).toEqual([4n, 3n, 3n]);
  });

  it('every share sums exactly to the total even with highly uneven weights', () => {
    const shares = apportionLargestRemainder(1000n, [700n, 200n, 100n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(1000n);
  });

  it('throws if total weight is zero but a nonzero total must be distributed', () => {
    expect(() => apportionLargestRemainder(100n, [0n, 0n])).toThrow();
  });

  it('handles a zero total cleanly', () => {
    expect(apportionLargestRemainder(0n, [1n, 2n, 3n])).toEqual([0n, 0n, 0n]);
  });
});
