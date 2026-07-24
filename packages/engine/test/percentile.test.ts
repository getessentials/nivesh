import { describe, expect, it } from 'vitest';
import { percentileOf } from '../src/percentile.ts';

describe('percentileOf', () => {
  it('ranks distinct values ascending with mid-rank percentile (docs/08 §1)', () => {
    const results = percentileOf([30, 10, 20], (v) => v);
    const byValue = Object.fromEntries(results.map((r) => [r.value, r.percentile]));
    // n=3: rank(10)=1 -> (1-0.5)/3=0.1667; rank(20)=2 -> 0.5; rank(30)=3 -> 0.8333
    expect(byValue[10]).toBeCloseTo(1 / 6, 10);
    expect(byValue[20]).toBeCloseTo(0.5, 10);
    expect(byValue[30]).toBeCloseTo(5 / 6, 10);
  });

  it('ties share the mean rank', () => {
    const results = percentileOf([10, 20, 20, 20, 30], (v) => v);
    const byValue = Object.fromEntries(results.map((r) => [r.value, r.percentile]));
    expect(byValue[10]).toBeCloseTo(0.1, 10); // (1-0.5)/5
    expect(byValue[20]).toBeCloseTo(0.5, 10); // mean rank 3 -> (3-0.5)/5
    expect(byValue[30]).toBeCloseTo(0.9, 10); // (5-0.5)/5
  });

  it('preserves the original item order in the returned array', () => {
    const results = percentileOf(['c', 'a', 'b'], (v) => v.charCodeAt(0));
    expect(results.map((r) => r.item)).toEqual(['c', 'a', 'b']);
  });

  it('applies a direction-normalization function (e.g. -TER: lower raw is better)', () => {
    const terValues = [1.0, 0.5, 0.2]; // lower TER = better = should rank HIGHER percentile
    const results = percentileOf(terValues, (ter) => -ter);
    const byTer = Object.fromEntries(results.map((r, i) => [terValues[i], r.percentile]));
    expect(byTer[0.2]).toBeGreaterThan(byTer[0.5]!);
    expect(byTer[0.5]).toBeGreaterThan(byTer[1.0]!);
  });

  it('a cohort of all-equal values gives everyone the same (median) percentile', () => {
    const results = percentileOf([5, 5, 5, 5], (v) => v);
    expect(results.every((r) => r.percentile === 0.5)).toBe(true);
  });

  it('handles an empty cohort without throwing', () => {
    expect(percentileOf([], (v: number) => v)).toEqual([]);
  });

  it('n=1 naturally yields percentile 0.5 (matches the docs/08 §1 degenerate-cohort rule)', () => {
    const results = percentileOf([42], (v) => v);
    expect(results[0]!.percentile).toBe(0.5);
  });
});
