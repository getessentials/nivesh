import { describe, expect, it } from 'vitest';
import {
  pearsonCorrelation, valueWeightedPortfolioReturns, diversifyFactor,
  DIVERSIFY_MIN_OVERLAP_TRADING_DAYS, NEUTRAL_DIVERSIFY, type HeldEtfSeries,
} from '../src/correlation.ts';
import type { SeriesPoint } from '../src/windows.ts';

function series(days: number, valueAt: (i: number) => number, startIso = '2026-01-01'): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let d = startIso;
  for (let i = 0; i < days; i++) {
    out.push({ d, value: valueAt(i) });
    const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
    d = new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
  }
  return out;
}

describe('pearsonCorrelation', () => {
  it('is 1 for perfectly correlated returns', () => {
    const a = new Map([['d1', 0.01], ['d2', 0.02], ['d3', -0.01]]);
    const b = new Map([['d1', 0.02], ['d2', 0.04], ['d3', -0.02]]); // exactly 2x a
    expect(pearsonCorrelation(a, b)).toBeCloseTo(1, 9);
  });
  it('is -1 for perfectly anti-correlated returns', () => {
    const a = new Map([['d1', 0.01], ['d2', 0.02], ['d3', -0.01]]);
    const b = new Map([['d1', -0.01], ['d2', -0.02], ['d3', 0.01]]);
    expect(pearsonCorrelation(a, b)).toBeCloseTo(-1, 9);
  });
  it('returns null with fewer than 2 overlapping observations', () => {
    expect(pearsonCorrelation(new Map([['d1', 0.01]]), new Map([['d1', 0.02]]))).toBeNull();
    expect(pearsonCorrelation(new Map(), new Map([['d1', 0.02]]))).toBeNull();
  });
  it('returns null when one series has zero variance', () => {
    const flat = new Map([['d1', 0.01], ['d2', 0.01], ['d3', 0.01]]);
    const varying = new Map([['d1', 0.01], ['d2', 0.02], ['d3', -0.01]]);
    expect(pearsonCorrelation(flat, varying)).toBeNull();
  });
});

describe('valueWeightedPortfolioReturns', () => {
  it('weights each holding by its current market value', () => {
    const etfA: HeldEtfSeries = {
      etfId: 1, marketValuePaise: 7_000_00n,
      navSeries: [{ d: '2026-01-01', value: 100 }, { d: '2026-01-02', value: 110 }], // +10%
    };
    const etfB: HeldEtfSeries = {
      etfId: 2, marketValuePaise: 3_000_00n,
      navSeries: [{ d: '2026-01-01', value: 50 }, { d: '2026-01-02', value: 45 }], // -10%
    };
    const portfolio = valueWeightedPortfolioReturns([etfA, etfB]);
    // 70% * +10% + 30% * -10% = 7% - 3% = 4%
    expect(portfolio.get('2026-01-02')).toBeCloseTo(0.04, 9);
  });

  it('drops a date entirely when any holding is missing an observation that day', () => {
    const etfA: HeldEtfSeries = {
      etfId: 1, marketValuePaise: 1n,
      navSeries: [{ d: '2026-01-01', value: 100 }, { d: '2026-01-02', value: 101 }, { d: '2026-01-03', value: 102 }],
    };
    const etfB: HeldEtfSeries = {
      etfId: 2, marketValuePaise: 1n,
      navSeries: [{ d: '2026-01-01', value: 50 }, { d: '2026-01-03', value: 51 }], // no 01-02 observation
    };
    const portfolio = valueWeightedPortfolioReturns([etfA, etfB]);
    expect(portfolio.has('2026-01-02')).toBe(false);
    expect(portfolio.has('2026-01-03')).toBe(true);
  });

  it('returns an empty map with no holdings or zero total market value', () => {
    expect(valueWeightedPortfolioReturns([]).size).toBe(0);
    const zeroed: HeldEtfSeries = { etfId: 1, marketValuePaise: 0n, navSeries: [{ d: '2026-01-01', value: 1 }] };
    expect(valueWeightedPortfolioReturns([zeroed]).size).toBe(0);
  });
});

describe('diversifyFactor', () => {
  it('is neutral 0.5 with no_holdings when the user has no current holdings', () => {
    const theme = series(200, (i) => 100 + i);
    expect(diversifyFactor(theme, [])).toEqual({ score: NEUTRAL_DIVERSIFY, tag: 'no_holdings', overlapTradingDays: 0 });
  });

  it('is neutral 0.5 with insufficient_history below the overlap threshold', () => {
    const theme = series(10, (i) => 100 + i);
    const holding: HeldEtfSeries = { etfId: 1, marketValuePaise: 1n, navSeries: series(10, (i) => 50 + i) };
    const result = diversifyFactor(theme, [holding]);
    expect(result.tag).toBe('insufficient_history');
    expect(result.score).toBe(NEUTRAL_DIVERSIFY);
    expect(result.overlapTradingDays).toBeLessThan(DIVERSIFY_MIN_OVERLAP_TRADING_DAYS);
  });

  it('computes 1 - |corr| when history is ample and holdings move independently', () => {
    const days = 200;
    const theme = series(days, (i) => 100 + Math.sin(i / 5) * 10);
    const holding: HeldEtfSeries = { etfId: 1, marketValuePaise: 1n, navSeries: series(days, (i) => 50 + i * 0.3) };
    const result = diversifyFactor(theme, [holding]);
    expect(result.tag).toBe('ok');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('is close to 0 when the theme series moves in lockstep with the sole holding', () => {
    const days = 200;
    const values = Array.from({ length: days }, (_, i) => 100 + i * 0.4 + Math.sin(i) * 3);
    const theme = series(days, (i) => values[i]!);
    const holding: HeldEtfSeries = { etfId: 1, marketValuePaise: 1n, navSeries: series(days, (i) => values[i]! * 2) };
    const result = diversifyFactor(theme, [holding]);
    expect(result.tag).toBe('ok');
    expect(result.score).toBeCloseTo(0, 6); // perfectly correlated -> |corr|=1 -> diversify=0
  });
});
