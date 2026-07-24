import { describe, expect, it } from 'vitest';
import { parseYahooChart } from '../src/parsers/yahoo.ts';

// Shape verified live against query1.finance.yahoo.com/v8/finance/chart/NIFTYBEES.NS (Phase 0).
function fixture(overrides: Partial<{ timestamp: number[]; close: (number | null)[]; volume: (number | null)[] }> = {}) {
  return {
    chart: {
      result: [
        {
          meta: { symbol: 'NIFTYBEES.NS', longName: 'Nippon India ETF Nifty 50 BeES' },
          timestamp: overrides.timestamp ?? [1753257000, 1753343400], // two consecutive trading days
          indicators: {
            quote: [
              {
                close: overrides.close ?? [271.74, 271.98],
                volume: overrides.volume ?? [1234567, 2345678],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

describe('parseYahooChart', () => {
  it('extracts symbol, longName, and bars', () => {
    const result = parseYahooChart(fixture());
    expect(result.symbol).toBe('NIFTYBEES.NS');
    expect(result.longName).toBe('Nippon India ETF Nifty 50 BeES');
    expect(result.bars).toHaveLength(2);
    expect(result.bars[0]).toMatchObject({ close: 271.74, volume: 1234567 });
    expect(result.bars[1]).toMatchObject({ close: 271.98, volume: 2345678 });
  });

  it('buckets a near-UTC-midnight timestamp into the correct IST trading day', () => {
    // 2026-07-22 18:30:00 UTC = 2026-07-23 00:00:00 IST -> should bucket to 2026-07-23
    const nearMidnight = Date.UTC(2026, 6, 22, 18, 30, 0) / 1000;
    const result = parseYahooChart(fixture({ timestamp: [nearMidnight], close: [100], volume: [1] }));
    expect(result.bars[0].date).toBe('2026-07-23');
  });

  it('skips bars with a null close (holiday gap in the requested range)', () => {
    const result = parseYahooChart(fixture({ close: [271.74, null] }));
    expect(result.bars).toHaveLength(1);
  });

  it('falls back to shortName when longName is absent', () => {
    const json = fixture();
    delete (json.chart.result[0].meta as any).longName;
    (json.chart.result[0].meta as any).shortName = 'NIFTYBEES';
    expect(parseYahooChart(json).longName).toBe('NIFTYBEES');
  });

  it('throws when the response has no result (bad symbol / endpoint error)', () => {
    expect(() => parseYahooChart({ chart: { result: [], error: { code: 'Not Found' } } })).toThrow();
    expect(() => parseYahooChart({})).toThrow();
  });

  it('treats missing volume as null rather than throwing', () => {
    const result = parseYahooChart(fixture({ volume: [null, null] }));
    expect(result.bars[0].volume).toBeNull();
  });
});
