import { describe, expect, it } from 'vitest';
import { rupeesToPaise, paiseToRupees } from '../src/money.ts';

describe('rupeesToPaise', () => {
  it('converts a clean value', () => {
    expect(rupeesToPaise(271.98)).toBe(27198n);
  });
  it('rounds half-up on the paisa', () => {
    expect(rupeesToPaise(273.0943)).toBe(27309n); // .43 paise -> rounds down
    expect(rupeesToPaise(273.0951)).toBe(27310n); // .51 paise -> rounds up
    expect(rupeesToPaise(1.005)).toBe(101n); // exact half -> rounds up (half-up rule)
  });
  it('handles negative amounts symmetrically', () => {
    expect(rupeesToPaise(-271.98)).toBe(-27198n);
  });
  it('rejects non-finite input', () => {
    expect(() => rupeesToPaise(NaN)).toThrow();
    expect(() => rupeesToPaise(Infinity)).toThrow();
  });
});

describe('paiseToRupees', () => {
  it('round-trips', () => {
    expect(paiseToRupees(27198n)).toBeCloseTo(271.98, 6);
    expect(paiseToRupees(27198)).toBeCloseTo(271.98, 6);
  });
});
