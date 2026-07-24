import { describe, expect, it } from 'vitest';
import { parseFlexibleDate } from '../src/parsers/dates.ts';

describe('parseFlexibleDate', () => {
  it('parses AMFI-style DD-Mon-YYYY', () => {
    expect(parseFlexibleDate('22-Jul-2026')).toBe('2026-07-22');
    expect(parseFlexibleDate('1-Jan-2026')).toBe('2026-01-01');
  });
  it('parses ISO YYYY-MM-DD unchanged', () => {
    expect(parseFlexibleDate('2026-07-22')).toBe('2026-07-22');
  });
  it('parses DD-MM-YYYY and DD/MM/YYYY', () => {
    expect(parseFlexibleDate('22-07-2026')).toBe('2026-07-22');
    expect(parseFlexibleDate('22/07/2026')).toBe('2026-07-22');
  });
  it('throws on garbage input', () => {
    expect(() => parseFlexibleDate('not a date')).toThrow();
    expect(() => parseFlexibleDate('22-Xyz-2026')).toThrow();
  });
});
