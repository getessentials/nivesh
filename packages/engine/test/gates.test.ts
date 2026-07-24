import { describe, expect, it } from 'vitest';
import {
  gateAum, gateListedDuration, gateAdtv, gateTrackingError, gateTer, gatePremiumDiscount,
  gateMetricsFreshness, evaluateGates, oneperIndexDedup, type EtfGateInputs,
} from '../src/gates.ts';

describe('gateAum (G1)', () => {
  it('broad ETFs need >= Rs 100cr', () => {
    expect(gateAum(100, false)).toEqual({ pass: true });
    expect(gateAum(99.99, false)).toMatchObject({ pass: false });
  });
  it('thematic ETFs need only >= Rs 50cr', () => {
    expect(gateAum(50, true)).toEqual({ pass: true });
    expect(gateAum(49.99, true)).toMatchObject({ pass: false });
  });
  it('missing AUM fails with a distinct reason', () => {
    expect(gateAum(null, true)).toEqual({ pass: false, reason: 'missing_aum' });
  });
});

describe('gateListedDuration (G2)', () => {
  it('>= 12 months passes', () => {
    expect(gateListedDuration('2025-01-05', '2026-01-05')).toEqual({ pass: true });
  });
  it('< 12 months fails', () => {
    expect(gateListedDuration('2025-06-05', '2026-01-05')).toMatchObject({ pass: false });
  });
  it('null listed_on is EXCLUDED, never guessed (docs/03 §3.1)', () => {
    expect(gateListedDuration(null, '2026-01-05')).toEqual({ pass: false, reason: 'missing_listing_date' });
  });
});

describe('gateAdtv (G3)', () => {
  it('>= Rs 25 lakh (in paise) passes', () => {
    expect(gateAdtv(25_00_000n * 100n)).toEqual({ pass: true });
  });
  it('below threshold fails', () => {
    expect(gateAdtv(24_99_999n * 100n)).toMatchObject({ pass: false });
  });
});

describe('gateTrackingError (G4)', () => {
  it('passes within the absolute 2% SEBI cap with no peer comparison needed', () => {
    expect(gateTrackingError(1.5, null, 0)).toEqual({ pass: true });
  });
  it('fails the absolute cap regardless of peer cohort', () => {
    expect(gateTrackingError(2.5, 3, 5)).toMatchObject({ pass: false, reason: 'tracking_error_exceeds_sebi_cap' });
  });
  it('peer-relative cap only applies when cohort >= 3 (docs/03 §3.1 degenerate-cohort fix)', () => {
    // TE=1.9 (under 2%) but 3x a peer median of 0.5 -> would fail peer-relative IF cohort>=3
    expect(gateTrackingError(1.9, 0.5, 2)).toEqual({ pass: true }); // cohort of 2 -> peer check skipped
    expect(gateTrackingError(1.9, 0.5, 3)).toMatchObject({ pass: false, reason: 'tracking_error_exceeds_peer_relative_cap' });
  });
});

describe('gateTer (G5)', () => {
  it('<= 1.0% passes', () => {
    expect(gateTer(1.0)).toEqual({ pass: true });
  });
  it('> 1.0% fails', () => {
    expect(gateTer(1.01)).toMatchObject({ pass: false });
  });
});

describe('gatePremiumDiscount (G6)', () => {
  it('both legs within 1% passes', () => {
    expect(gatePremiumDiscount(0.5, 0.9)).toEqual({ pass: true });
  });
  it('30d average exceeding 1% fails even if plan-day is fine', () => {
    expect(gatePremiumDiscount(1.5, 0.1)).toMatchObject({ pass: false, reason: 'avg_premium_discount_exceeds_threshold' });
  });
  it('plan-day premium exceeding 1% fails even if the 30d average is fine (MON100 scenario, docs/02 §6)', () => {
    expect(gatePremiumDiscount(0.5, 20.3)).toMatchObject({ pass: false, reason: 'plan_day_premium_exceeds_threshold' });
  });
  it('a negative (discount) value is judged by absolute magnitude', () => {
    expect(gatePremiumDiscount(-1.5, 0)).toMatchObject({ pass: false });
  });
});

describe('gateMetricsFreshness (G7 / docs/10 §4)', () => {
  it('<= 45 days old passes', () => {
    expect(gateMetricsFreshness('2026-06-08', '2026-07-23')).toEqual({ pass: true }); // 45 days exactly
  });
  it('> 45 days old fails as stale_metrics', () => {
    expect(gateMetricsFreshness('2026-06-01', '2026-07-23')).toEqual({ pass: false, reason: 'stale_metrics' });
  });
  it('no metrics at all fails as stale_metrics too', () => {
    expect(gateMetricsFreshness(null, '2026-07-23')).toEqual({ pass: false, reason: 'stale_metrics' });
  });
});

describe('evaluateGates', () => {
  const passing: EtfGateInputs = {
    aumCr: 200, isThematic: false, listedOn: '2020-01-01', adtvPaise: 30_00_000n * 100n,
    trackingError1y: 1.0, sameIndexPeerMedianTe: 1.0, sameIndexPeerCohortSize: 5, terPct: 0.5,
    avg30dPremiumDiscountPct: 0.2, planDayPremiumPct: 0.3, metricsAsOf: '2026-07-01', asOfDate: '2026-07-23',
  };

  it('an ETF passing all gates is eligible with no failure reasons', () => {
    expect(evaluateGates(passing)).toEqual({ eligible: true, failureReasons: [] });
  });

  it('collects EVERY failing gate, not just the first (docs/01 §4 excluded-ETF reasons)', () => {
    const outcome = evaluateGates({ ...passing, aumCr: 10, terPct: 2.0 });
    expect(outcome.eligible).toBe(false);
    expect(outcome.failureReasons).toContain('aum_below_threshold');
    expect(outcome.failureReasons).toContain('ter_exceeds_threshold');
    expect(outcome.failureReasons).toHaveLength(2);
  });
});

describe('oneperIndexDedup (docs/03 §3.3)', () => {
  it('keeps the higher-scored ETF per index, reports the loser as a runner-up', () => {
    const picks = [
      { etfId: 1, underlyingIndex: 'NIFTY 50', sEtfFinal: 80, terPct: 0.1, aumCr: 5000 },
      { etfId: 2, underlyingIndex: 'NIFTY 50', sEtfFinal: 90, terPct: 0.2, aumCr: 3000 },
      { etfId: 3, underlyingIndex: 'NIFTY IT', sEtfFinal: 70, terPct: 0.3, aumCr: 1000 },
    ];
    const { kept, runnersUp } = oneperIndexDedup(picks);
    expect(kept.map((p) => p.etfId).sort()).toEqual([2, 3]);
    expect(runnersUp).toHaveLength(1);
    expect(runnersUp[0]!.pick.etfId).toBe(1);
    expect(runnersUp[0]!.lostTo.etfId).toBe(2);
  });

  it('ties break by lower TER, then higher AUM, then lower etfId (docs/03 §3.2)', () => {
    const picks = [
      { etfId: 5, underlyingIndex: 'X', sEtfFinal: 80, terPct: 0.2, aumCr: 100 },
      { etfId: 2, underlyingIndex: 'X', sEtfFinal: 80, terPct: 0.1, aumCr: 50 }, // lower TER -> wins
    ];
    const { kept } = oneperIndexDedup(picks);
    expect(kept[0]!.etfId).toBe(2);
  });

  it('a unique index with a single pick has no runner-up', () => {
    const picks = [{ etfId: 1, underlyingIndex: 'SOLO', sEtfFinal: 50, terPct: 0.1, aumCr: 100 }];
    const { kept, runnersUp } = oneperIndexDedup(picks);
    expect(kept).toHaveLength(1);
    expect(runnersUp).toHaveLength(0);
  });
});
