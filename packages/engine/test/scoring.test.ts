import { describe, expect, it } from 'vitest';
import {
  themeScore, themeScoreFinal, etfScore, etfScoreFinal, breadthRaw, trackingQualityBlend,
} from '../src/scoring.ts';

describe('themeScore (docs/03 §2.3)', () => {
  it('weights sum correctly at maximum: policy(5/5)=25, all percentiles=1 -> 100', () => {
    const s = themeScore({
      policyTailwind0to5: 5, momentumPercentile: 1, trendPercentile: 1, breadthPercentile: 1, diversifyScore: 1,
    });
    expect(s).toBeCloseTo(100, 10);
  });
  it('at minimum: policy=0, all percentiles=0 -> 0', () => {
    const s = themeScore({
      policyTailwind0to5: 0, momentumPercentile: 0, trendPercentile: 0, breadthPercentile: 0, diversifyScore: 0,
    });
    expect(s).toBe(0);
  });
  it('policy contributes at most 25% regardless of an out-of-range LLM value (clamped 0-5)', () => {
    const s = themeScore({
      policyTailwind0to5: 999, momentumPercentile: 0, trendPercentile: 0, breadthPercentile: 0, diversifyScore: 0,
    });
    expect(s).toBe(25);
  });
  it('a mid-range example matches hand computation', () => {
    // policy 2.5/5=0.5*25=12.5; momentum 0.8*25=20; trend 0.6*20=12; breadth 0.4*15=6; diversify 0.5*15=7.5
    const s = themeScore({
      policyTailwind0to5: 2.5, momentumPercentile: 0.8, trendPercentile: 0.6, breadthPercentile: 0.4, diversifyScore: 0.5,
    });
    expect(s).toBeCloseTo(12.5 + 20 + 12 + 6 + 7.5, 10);
  });
});

describe('themeScoreFinal', () => {
  it('adds the (possibly negative) decayed theme_adj', () => {
    expect(themeScoreFinal(70, 6)).toBe(76);
    expect(themeScoreFinal(70, -6)).toBe(64);
  });
});

describe('etfScore (docs/03 §3.2)', () => {
  it('weights sum correctly at maximum -> 100', () => {
    const s = etfScore({
      trackingQualityPercentile: 1, liquidityPercentile: 1, costPercentile: 1,
      scalePercentile: 1, peerReturnPercentile: 1, momentumPercentile: 1, hasShortHistory: false,
    });
    expect(s).toBe(100);
  });
  it('at minimum -> 0', () => {
    const s = etfScore({
      trackingQualityPercentile: 0, liquidityPercentile: 0, costPercentile: 0,
      scalePercentile: 0, peerReturnPercentile: 0, momentumPercentile: 0, hasShortHistory: false,
    });
    expect(s).toBe(0);
  });
  it('shortHistoryPenalty subtracts 5 AFTER summation, before the floor/cap clamp', () => {
    const withPenalty = etfScore({
      trackingQualityPercentile: 1, liquidityPercentile: 1, costPercentile: 1,
      scalePercentile: 1, peerReturnPercentile: 1, momentumPercentile: 1, hasShortHistory: true,
    });
    expect(withPenalty).toBe(95); // 100 - 5, not clamped away since 95 is still in [0,100]
  });
  it('the penalty cannot push the score below the 0 floor', () => {
    const s = etfScore({
      trackingQualityPercentile: 0, liquidityPercentile: 0, costPercentile: 0,
      scalePercentile: 0, peerReturnPercentile: 0.01, momentumPercentile: 0, hasShortHistory: true,
    });
    expect(s).toBe(0); // 0.15 - 5 would be negative -> floored at 0
  });
});

describe('etfScoreFinal', () => {
  it('adds etf_adj (which may push above 100 or below 0 — no re-clamp per docs/03 §3.2)', () => {
    expect(etfScoreFinal(95, 8)).toBe(103); // S_etf_final is not re-clamped after adding etf_adj
    expect(etfScoreFinal(3, -8)).toBe(-5);
  });
});

describe('breadthRaw', () => {
  it('averages the two percentiles equally (docs/08 §7)', () => {
    expect(breadthRaw(0.8, 0.4)).toBeCloseTo(0.6, 10);
  });
});

describe('trackingQualityBlend', () => {
  it('blends 0.6/0.4 when TD_3y exists', () => {
    expect(trackingQualityBlend(0.8, 0.5)).toBeCloseTo(0.6 * 0.8 + 0.4 * 0.5, 10);
  });
  it('uses the 1y percentile alone when TD_3y is null', () => {
    expect(trackingQualityBlend(0.8, null)).toBe(0.8);
  });
});
