import { describe, expect, it } from 'vitest';
import { equityPct, themeCountRange, coreSharePct } from '../src/profile.ts';

describe('equityPct', () => {
  it('moderate: clamp(115-age, 40, 90)', () => {
    expect(equityPct(40, 'moderate')).toBe(75);
    expect(equityPct(70, 'moderate')).toBe(45);
  });
  it('conservative: -10 adjustment', () => {
    expect(equityPct(40, 'conservative')).toBe(65);
  });
  it('aggressive: +10 adjustment', () => {
    expect(equityPct(40, 'aggressive')).toBe(85);
  });
  it('clamps at the floor (40) for very old ages', () => {
    expect(equityPct(90, 'conservative')).toBe(40);
  });
  it('clamps at the ceiling (90) for very young ages', () => {
    expect(equityPct(10, 'aggressive')).toBe(90);
  });
  it('throws on a non-finite age rather than silently propagating NaN several calls downstream', () => {
    expect(() => equityPct(NaN, 'moderate')).toThrow(/finite/);
    expect(() => equityPct(Infinity, 'moderate')).toThrow(/finite/);
  });
});

describe('themeCountRange', () => {
  it('conservative: 1-2, moderate: 2-4, aggressive: 3-5', () => {
    expect(themeCountRange('conservative')).toEqual({ min: 1, max: 2 });
    expect(themeCountRange('moderate')).toEqual({ min: 2, max: 4 });
    expect(themeCountRange('aggressive')).toEqual({ min: 3, max: 5 });
  });
});

describe('coreSharePct', () => {
  it('conservative 80, moderate 65, aggressive 50', () => {
    expect(coreSharePct('conservative')).toBe(80);
    expect(coreSharePct('moderate')).toBe(65);
    expect(coreSharePct('aggressive')).toBe(50);
  });
});
