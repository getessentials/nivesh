import { describe, expect, it } from 'vitest';
import { checkTimeSeriesRow } from '../src/sanity-gates.ts';

const today = '2026-07-23';

describe('checkTimeSeriesRow', () => {
  it('accepts a clean first observation (no previous)', () => {
    expect(checkTimeSeriesRow({ value: 100, date: today, today })).toEqual({ ok: true });
  });

  it('rejects zero/negative values', () => {
    expect(checkTimeSeriesRow({ value: 0, date: today, today })).toEqual({ ok: false, reason: 'nonpositive' });
    expect(checkTimeSeriesRow({ value: -5, date: today, today })).toEqual({ ok: false, reason: 'nonpositive' });
  });

  it('rejects a future-dated row', () => {
    expect(checkTimeSeriesRow({ value: 100, date: '2026-07-24', today })).toEqual({ ok: false, reason: 'future_date' });
  });

  it('rejects a date before the previous observation (non-monotonic)', () => {
    expect(checkTimeSeriesRow({
      value: 100, date: '2026-07-22', today, previous: { date: '2026-07-23', value: 99 },
    })).toEqual({ ok: false, reason: 'non_monotonic_date' });
  });

  it('allows a benign same-day re-upsert without a move check', () => {
    // 900% "move" vs previous but SAME date -> not a new observation, no jump check applies
    expect(checkTimeSeriesRow({
      value: 1000, date: '2026-07-23', today, previous: { date: '2026-07-23', value: 100 },
    })).toEqual({ ok: true });
  });

  it('accepts a move within the default 20% bound', () => {
    expect(checkTimeSeriesRow({
      value: 118, date: '2026-07-23', today, previous: { date: '2026-07-22', value: 100 },
    })).toEqual({ ok: true }); // +18%
  });

  it('rejects a move exceeding the default 20% bound', () => {
    expect(checkTimeSeriesRow({
      value: 125, date: '2026-07-23', today, previous: { date: '2026-07-22', value: 100 },
    })).toEqual({ ok: false, reason: 'jump>20%' }); // +25%
  });

  it('rejects a large downward move too (absolute value)', () => {
    expect(checkTimeSeriesRow({
      value: 70, date: '2026-07-23', today, previous: { date: '2026-07-22', value: 100 },
    })).toEqual({ ok: false, reason: 'jump>20%' }); // -30%
  });

  it('respects a configurable maxMovePct', () => {
    expect(checkTimeSeriesRow({
      value: 140, date: '2026-07-23', today, previous: { date: '2026-07-22', value: 100 }, maxMovePct: 50,
    })).toEqual({ ok: true }); // +40%, within a wider 50% bound
  });
});
