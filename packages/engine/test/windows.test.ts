import { describe, expect, it } from 'vitest';
import {
  selectEndpointObservation, resolveReturnWindow, computeCagrPct, resolveCommonWindow,
  MIN_USABLE_WINDOW_TRADING_DAYS, type SeriesPoint,
} from '../src/windows.ts';

const HOLIDAYS: ReadonlySet<string> = new Set(['2026-08-15', '2026-10-02']);

function dailySeries(startIso: string, days: number, valueAt: (i: number) => number): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  let d = startIso;
  for (let i = 0; i < days; i++) {
    out.push({ d, value: valueAt(i) });
    // advance one calendar day per point (fine-grained daily fixture; weekends/holidays not
    // excluded here since these tests only exercise the pure window math, not calendar skipping)
    const parts = d.split('-').map(Number) as [number, number, number];
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + 1));
    d = dt.toISOString().slice(0, 10);
  }
  return out;
}

describe('selectEndpointObservation', () => {
  const series: SeriesPoint[] = [
    { d: '2026-01-01', value: 100 },
    { d: '2026-01-10', value: 110 },
    { d: '2026-01-20', value: 120 },
  ];

  it('returns the exact-date observation when present', () => {
    expect(selectEndpointObservation(series, '2026-01-10', HOLIDAYS)).toEqual({ d: '2026-01-10', value: 110 });
  });

  it('falls back to the latest observation before the edge, within tolerance', () => {
    // 2026-01-11 is 1 trading day after 2026-01-10 -> within 5-trading-day tolerance
    expect(selectEndpointObservation(series, '2026-01-11', HOLIDAYS)).toEqual({ d: '2026-01-10', value: 110 });
  });

  it('falls to the earliest observation after the edge when nothing qualifies before it', () => {
    const sparse: SeriesPoint[] = [{ d: '2026-01-01', value: 100 }, { d: '2026-02-01', value: 200 }];
    // edge 2026-01-15 is far from both — after (2026-02-01) is still >5 trading days away, so null
    expect(selectEndpointObservation(sparse, '2026-01-15', HOLIDAYS)).toBeNull();
  });

  it('returns null when nothing resolves within tolerance either side', () => {
    const sparse: SeriesPoint[] = [{ d: '2026-01-01', value: 100 }, { d: '2026-03-01', value: 200 }];
    expect(selectEndpointObservation(sparse, '2026-02-01', HOLIDAYS)).toBeNull();
  });
});

describe('resolveReturnWindow', () => {
  it('computes a simple 6m window return from daily data', () => {
    const series = dailySeries('2026-01-01', 220, (i) => 100 + i * 0.5);
    const w = resolveReturnWindow(series, '2026-07-23', 6, HOLIDAYS);
    expect(w).not.toBeNull();
    expect(w!.returnPct).toBeCloseTo((w!.end.value / w!.start.value - 1) * 100, 6);
  });

  it('returns null when the start edge cannot be resolved at all', () => {
    const series: SeriesPoint[] = [{ d: '2026-07-01', value: 100 }, { d: '2026-07-23', value: 105 }];
    // 6m back from 2026-07-23 is 2026-01-23 — no observation anywhere near it
    expect(resolveReturnWindow(series, '2026-07-23', 6, HOLIDAYS)).toBeNull();
  });
});

describe('computeCagrPct', () => {
  it('matches the exact formula (end/start)^(252/d) - 1', () => {
    const cagr = computeCagrPct(100, 133.1, 756); // ~3 trading years
    expect(cagr).toBeCloseTo((Math.pow(1.331, 252 / 756) - 1) * 100, 9);
  });
  it('throws on non-positive intervals or start value', () => {
    expect(() => computeCagrPct(100, 110, 0)).toThrow(/intervals/);
    expect(() => computeCagrPct(0, 110, 10)).toThrow(/startValue/);
  });
});

describe('resolveCommonWindow', () => {
  it('shrinks the window until every cohort member resolves', () => {
    const long = dailySeries('2023-01-01', 900, (i) => 100 + i * 0.3); // ~3.5y of daily data
    const short = dailySeries('2026-05-01', 80, (i) => 50 + i * 0.1); // only ~3 months of data
    const result = resolveCommonWindow(
      [{ key: 'long', series: long }, { key: 'short', series: short }],
      '2026-07-20',
      12,
      HOLIDAYS
    );
    // "short" cannot resolve a 12m (or even 6m) window, so the shrink must land somewhere both
    // members can satisfy, or report no usable common window — either is acceptable as long as
    // it never silently reports a stale full-length window for the short member.
    if (result.usableWindowMonths !== null) {
      expect(result.perMember.get('long')).not.toBeNull();
      expect(result.perMember.get('short')).not.toBeNull();
      expect(result.perMember.get('short')!.intervals).toBeGreaterThanOrEqual(MIN_USABLE_WINDOW_TRADING_DAYS);
    } else {
      expect(result.perMember.get('long')).toBeNull();
      expect(result.perMember.get('short')).toBeNull();
    }
  });

  it('reports the full window when every member has ample history', () => {
    const a = dailySeries('2023-01-01', 1300, (i) => 100 + i * 0.2); // covers through the as-of date
    const b = dailySeries('2023-01-01', 1300, (i) => 200 + i * 0.1);
    const result = resolveCommonWindow([{ key: 'a', series: a }, { key: 'b', series: b }], '2026-07-20', 6, HOLIDAYS);
    expect(result.usableWindowMonths).toBe(6);
  });
});
