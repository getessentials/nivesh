import { describe, expect, it } from 'vitest';
import { parseFlexibleDate, isoDateToDDMonYYYY } from '../src/parsers/dates.ts';

describe('parseFlexibleDate', () => {
  it('parses AMFI-style DD-Mon-YYYY', () => {
    expect(parseFlexibleDate('22-Jul-2026')).toBe('2026-07-22');
    expect(parseFlexibleDate('1-Jan-2026')).toBe('2026-01-01');
  });
  it('parses niftyindices-style "DD Mon YYYY" (space-separated)', () => {
    expect(parseFlexibleDate('23 Jul 2026')).toBe('2026-07-23');
    expect(parseFlexibleDate('9 Jan 2026')).toBe('2026-01-09');
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

describe('isoDateToDDMonYYYY', () => {
  it('formats ISO dates as DD-Mon-YYYY', () => {
    expect(isoDateToDDMonYYYY('2026-07-24')).toBe('24-Jul-2026');
    expect(isoDateToDDMonYYYY('2026-01-01')).toBe('01-Jan-2026');
  });
  it('round-trips through parseFlexibleDate', () => {
    expect(parseFlexibleDate(isoDateToDDMonYYYY('2026-07-24'))).toBe('2026-07-24');
  });
  it('throws on non-ISO input', () => {
    expect(() => isoDateToDDMonYYYY('24-Jul-2026')).toThrow();
  });
});
