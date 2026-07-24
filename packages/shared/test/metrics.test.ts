import { describe, expect, it } from 'vitest';
import { computeAdtv, computePremiumDiscount30d, type PriceObs, type NavObs } from '../src/metrics.ts';

function daysBack(asOf: string, n: number): string {
  const d = new Date(`${asOf}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

describe('computeAdtv', () => {
  const asOf = '2026-07-23';

  it('returns insufficient_data with fewer than 20 observations', () => {
    const prices: PriceObs[] = Array.from({ length: 10 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 27000n, volume: 1000,
    }));
    const result = computeAdtv(prices, asOf);
    expect(result).toEqual({ adtvPaise: null, obsCount: 10, reason: 'insufficient_data' });
  });

  it('averages close*volume over the last 30 observations on/before asOf', () => {
    // 40 daily rows, uniform close=100paise, volume=10 -> traded value 1000 every day
    const prices: PriceObs[] = Array.from({ length: 40 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 100n, volume: 10,
    }));
    const result = computeAdtv(prices, asOf);
    expect(result.obsCount).toBe(30); // windowed to 30, not all 40
    expect(result.adtvPaise).toBe(1000n);
  });

  it('does NOT reach past a 45-day calendar cutoff to fill the 30-observation window across a gap', () => {
    // 15 recent rows (within the last 15 days), a genuine data gap, then 20 much older rows
    // (60-80 days back). A naive row-count-only window would happily take 15 recent + 15 old
    // rows to reach 30 "observations" — blending in 2-month-stale prices as if recent.
    const recent: PriceObs[] = Array.from({ length: 15 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 999999n, volume: 1, // deliberately outlandish so a leak would be obvious
    }));
    const old: PriceObs[] = Array.from({ length: 20 }, (_, i) => ({
      d: daysBack(asOf, 60 + i), closePaise: 100n, volume: 10,
    }));
    const result = computeAdtv([...recent, ...old], asOf);
    // Only the 15 recent rows are within the 45-day lookback bound -> starved below MIN_OBS.
    expect(result).toEqual({ adtvPaise: null, obsCount: 15, reason: 'insufficient_data' });
  });

  it('excludes future-dated rows (after asOf) from the window', () => {
    const prices: PriceObs[] = [
      ...Array.from({ length: 25 }, (_, i) => ({ d: daysBack(asOf, i), closePaise: 100n, volume: 10 })),
      { d: '2026-07-24', closePaise: 999999n, volume: 999999 }, // future, must be excluded
    ];
    const result = computeAdtv(prices, asOf);
    expect(result.obsCount).toBe(25);
    expect(result.adtvPaise).toBe(1000n);
  });

  it('skips rows with a null volume (not counted toward the 20-obs minimum)', () => {
    const prices: PriceObs[] = Array.from({ length: 25 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 100n, volume: i < 5 ? null : 10,
    }));
    const result = computeAdtv(prices, asOf);
    expect(result.obsCount).toBe(20); // 25 - 5 null-volume rows
  });
});

describe('computePremiumDiscount30d', () => {
  const asOf = '2026-07-23';

  it('computes average (price-nav)/nav % over matched dates only', () => {
    const prices: PriceObs[] = Array.from({ length: 25 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 10100n, volume: 1, // price = 101.00
    }));
    const navs: NavObs[] = Array.from({ length: 25 }, (_, i) => ({
      d: daysBack(asOf, i), navPaise: 10000n, // nav = 100.00 -> +1% premium every day
    }));
    const result = computePremiumDiscount30d(prices, navs, asOf);
    expect(result.obsCount).toBe(25);
    expect(result.avgPct).toBeCloseTo(1.0, 6);
  });

  it('is insufficient_data below 20 matched observations even with plenty of price rows', () => {
    const prices: PriceObs[] = Array.from({ length: 25 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 10100n, volume: 1,
    }));
    const navs: NavObs[] = Array.from({ length: 10 }, (_, i) => ({ d: daysBack(asOf, i), navPaise: 10000n }));
    const result = computePremiumDiscount30d(prices, navs, asOf);
    expect(result).toEqual({ avgPct: null, obsCount: 10, reason: 'insufficient_data' });
  });

  it('handles a discount (negative premium) correctly', () => {
    const prices: PriceObs[] = Array.from({ length: 20 }, (_, i) => ({
      d: daysBack(asOf, i), closePaise: 9900n, volume: 1, // price = 99.00
    }));
    const navs: NavObs[] = Array.from({ length: 20 }, (_, i) => ({ d: daysBack(asOf, i), navPaise: 10000n }));
    const result = computePremiumDiscount30d(prices, navs, asOf);
    expect(result.avgPct).toBeCloseTo(-1.0, 6);
  });
});
