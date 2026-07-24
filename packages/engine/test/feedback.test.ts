import { describe, expect, it } from 'vitest';
import {
  classifyStatus, decayAdjustment, etfIncrement, themeIncrement, incumbentWinsStickiness,
  rotationAdvice, shouldProposeRotation, THEME_ADJ_BOUND, ETF_ADJ_BOUND,
} from '../src/feedback.ts';

describe('classifyStatus', () => {
  it('OUTPERFORM: excess >= +1% AND peerGap >= 0', () => {
    expect(classifyStatus(1.5, 0.5, null)).toBe('OUTPERFORM');
    expect(classifyStatus(1.0, 0, null)).toBe('OUTPERFORM'); // boundary inclusive
  });
  it('not OUTPERFORM if peerGap is negative, even with strong excess', () => {
    expect(classifyStatus(5, -0.1, null)).toBe('INLINE');
  });
  it('LAG requires excess <= -3% in BOTH this period and the previous one', () => {
    expect(classifyStatus(-3.5, 0, -3.2)).toBe('LAG');
    expect(classifyStatus(-3.5, 0, null)).toBe('INLINE'); // first-ever observation, no "previous"
    expect(classifyStatus(-3.5, 0, -2.9)).toBe('INLINE'); // previous wasn't <= -3%
  });
  it('everything else is INLINE', () => {
    expect(classifyStatus(0.5, 0.5, null)).toBe('INLINE');
    expect(classifyStatus(-1, 0, -5)).toBe('INLINE'); // this period doesn't qualify even if previous did
  });
});

describe('decayAdjustment', () => {
  it('adj_0 = 0, first increment with no decay history', () => {
    expect(decayAdjustment(0, 1, 6, THEME_ADJ_BOUND)).toBe(6);
  });
  it('applies half-life-6-months decay before adding the increment', () => {
    // previous=12, deltaMonths=6 (one half-life) -> decays to 6, plus increment 6 -> 12
    expect(decayAdjustment(12, 6, 6, THEME_ADJ_BOUND)).toBeCloseTo(12, 10);
  });
  it('clamps to the bound', () => {
    expect(decayAdjustment(10, 0, 6, THEME_ADJ_BOUND)).toBe(THEME_ADJ_BOUND); // 16 clamped to 12
    expect(decayAdjustment(-10, 0, -6, THEME_ADJ_BOUND)).toBe(-THEME_ADJ_BOUND);
  });
  it('a skipped month still decays (deltaMonths=2 per docs/08 §7 example)', () => {
    const decayedOnly = decayAdjustment(12, 2, 0, THEME_ADJ_BOUND);
    expect(decayedOnly).toBeLessThan(12);
    expect(decayedOnly).toBeGreaterThan(0);
  });
  it('etf bound is 8, distinct from theme bound 12', () => {
    expect(decayAdjustment(10, 0, 4, ETF_ADJ_BOUND)).toBe(ETF_ADJ_BOUND);
  });
});

describe('etfIncrement', () => {
  it('maps status to +-4/0', () => {
    expect(etfIncrement('OUTPERFORM')).toBe(4);
    expect(etfIncrement('LAG')).toBe(-4);
    expect(etfIncrement('INLINE')).toBe(0);
  });
});

describe('themeIncrement — market-value-weighted majority', () => {
  it('net OUTPERFORM when OUTPERFORM MV exceeds LAG MV', () => {
    const held = [
      { status: 'OUTPERFORM' as const, marketValuePaise: 700_000n },
      { status: 'LAG' as const, marketValuePaise: 300_000n },
    ];
    expect(themeIncrement(held)).toBe(6);
  });
  it('net LAG when LAG MV exceeds OUTPERFORM MV', () => {
    const held = [
      { status: 'OUTPERFORM' as const, marketValuePaise: 200_000n },
      { status: 'LAG' as const, marketValuePaise: 800_000n },
    ];
    expect(themeIncrement(held)).toBe(-6);
  });
  it('equal MV (including all-INLINE) -> 0', () => {
    expect(themeIncrement([{ status: 'INLINE', marketValuePaise: 1_000_000n }])).toBe(0);
    const tied = [
      { status: 'OUTPERFORM' as const, marketValuePaise: 500_000n },
      { status: 'LAG' as const, marketValuePaise: 500_000n },
    ];
    expect(themeIncrement(tied)).toBe(0);
  });
  it('an empty holding set is neutral', () => {
    expect(themeIncrement([])).toBe(0);
  });
});

describe('incumbentWinsStickiness', () => {
  it('an INLINE incumbent beats a challenger who is not >8 points better', () => {
    expect(incumbentWinsStickiness('INLINE', 70, 78)).toBe(true); // +8 exactly, not >8
    expect(incumbentWinsStickiness('INLINE', 70, 78.1)).toBe(false);
  });
  it('an OUTPERFORM incumbent gets the same protection as INLINE', () => {
    expect(incumbentWinsStickiness('OUTPERFORM', 70, 78)).toBe(true);
  });
  it('a LAG incumbent gets NO stickiness protection', () => {
    expect(incumbentWinsStickiness('LAG', 70, 71)).toBe(false);
  });
});

describe('rotationAdvice', () => {
  it('within the close window (10-12 months for a 12-month clock) and low drawdown -> hold', () => {
    expect(rotationAdvice(10.5, 12, 5)).toBe('hold_to_ltcg');
    expect(rotationAdvice(11, 12, 10)).toBe('hold_to_ltcg'); // boundary inclusive
  });
  it('within the close window but drawdown > 10% -> rotate now anyway', () => {
    expect(rotationAdvice(10.5, 12, 10.1)).toBe('rotate_now');
  });
  it('already past the LTCG date -> rotate now (no tax-timing reason to wait)', () => {
    expect(rotationAdvice(13, 12, 0)).toBe('rotate_now');
  });
  it('still far from the LTCG date -> rotate now (waiting too long isn\'t advised)', () => {
    expect(rotationAdvice(4, 12, 0)).toBe('rotate_now');
  });
  it('generalizes to a different LTCG clock (e.g. 24 months for an intl FoF)', () => {
    expect(rotationAdvice(23, 24, 3)).toBe('hold_to_ltcg');
  });
});

describe('shouldProposeRotation', () => {
  it('proposes only at 2+ consecutive LAG runs', () => {
    expect(shouldProposeRotation(0)).toBe(false);
    expect(shouldProposeRotation(1)).toBe(false);
    expect(shouldProposeRotation(2)).toBe(true);
    expect(shouldProposeRotation(3)).toBe(true);
  });
});
