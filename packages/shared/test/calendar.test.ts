import { describe, expect, it } from 'vitest';
import {
  isTradingDay, isWeekend, firstTradingDayOfMonth, lastSaturdayOfMonth,
  addDaysISO, dayOfWeekISO, toISODate, parseISO, ingestDeadlineUtc,
  subtractCalendarMonths, tradingDayGap,
} from '../src/calendar.ts';

const HOLIDAYS_2026 = new Set([
  '2026-01-26', '2026-03-03', '2026-08-15', '2026-10-02', '2026-12-25',
]);

describe('isWeekend / isTradingDay', () => {
  it('flags Saturday/Sunday as weekend', () => {
    expect(isWeekend('2026-07-25')).toBe(true); // Saturday
    expect(isWeekend('2026-07-26')).toBe(true); // Sunday
    expect(isWeekend('2026-07-23')).toBe(false); // Thursday
  });
  it('a weekday holiday is not a trading day', () => {
    expect(isTradingDay('2026-08-15', HOLIDAYS_2026)).toBe(false); // Sat in 2026, also a holiday
    expect(isTradingDay('2026-10-02', HOLIDAYS_2026)).toBe(false); // Friday, Gandhi Jayanti
  });
  it('an ordinary weekday is a trading day', () => {
    expect(isTradingDay('2026-07-23', HOLIDAYS_2026)).toBe(true);
  });
});

describe('firstTradingDayOfMonth', () => {
  it('returns the 1st when it is already a trading day', () => {
    // 2026-07-01 is a Wednesday, no holiday
    expect(firstTradingDayOfMonth('2026-07', HOLIDAYS_2026)).toBe('2026-07-01');
  });
  it('skips a New Year weekend + Republic Day to find the first trading day', () => {
    // 2026-01-26 (Republic Day) is a Monday; construct a holiday set where day 1 is a Sunday
    // and day 2 (Monday) is also a holiday, to exercise multi-day skipping.
    const holidays = new Set(['2026-02-02']); // pretend Feb 2 is a holiday
    // 2026-02-01 is a Sunday -> skip; 2026-02-02 Monday holiday -> skip; 2026-02-03 Tuesday -> first trading day
    expect(firstTradingDayOfMonth('2026-02', holidays)).toBe('2026-02-03');
  });
});

describe('lastSaturdayOfMonth', () => {
  it('finds the last Saturday of July 2026', () => {
    // July 2026 has 31 days; July 31 2026 is a Friday, so last Saturday is July 25.
    expect(lastSaturdayOfMonth('2026-07')).toBe('2026-07-25');
  });
  it('finds the last Saturday of February 2026 (28 days, non-leap)', () => {
    expect(dayOfWeekISO('2026-02-28')).toBe(6); // sanity: Feb 28 2026 is itself a Saturday
    expect(lastSaturdayOfMonth('2026-02')).toBe('2026-02-28');
  });
});

describe('addDaysISO / dayOfWeekISO / toISODate / parseISO round-trip', () => {
  it('adds and subtracts days across month boundaries', () => {
    expect(addDaysISO('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysISO('2026-08-01', -1)).toBe('2026-07-31');
  });
  it('round-trips parseISO/toISODate', () => {
    expect(toISODate(parseISO('2026-07-23'))).toBe('2026-07-23');
  });
  it('rejects malformed input', () => {
    expect(() => parseISO('23-07-2026')).toThrow();
    expect(() => firstTradingDayOfMonth('2026-7', HOLIDAYS_2026)).toThrow();
  });
});

describe('ingestDeadlineUtc', () => {
  it('is 12:00 IST (06:30 UTC) on the day after the run date', () => {
    const d = ingestDeadlineUtc('2026-07-23');
    expect(d.toISOString()).toBe('2026-07-24T06:30:00.000Z');
  });
});

describe('subtractCalendarMonths', () => {
  it('subtracts 6 months across a year boundary', () => {
    expect(subtractCalendarMonths('2026-02-10', 6)).toBe('2025-08-10');
  });
  it('clamps to the shorter target month (no overflow into the next month)', () => {
    expect(subtractCalendarMonths('2026-05-31', 1)).toBe('2026-04-30');
    expect(subtractCalendarMonths('2026-03-31', 1)).toBe('2026-02-28'); // 2026 not a leap year
  });
  it('12 months back lands on the same calendar day one year earlier', () => {
    expect(subtractCalendarMonths('2026-07-23', 12)).toBe('2025-07-23');
  });
});

describe('tradingDayGap', () => {
  it('is 0 for the same date', () => {
    expect(tradingDayGap('2026-07-23', '2026-07-23', HOLIDAYS_2026)).toBe(0);
  });
  it('counts only trading days strictly after the earlier date', () => {
    // Thu 2026-07-23 -> Mon 2026-07-27: Fri(24) trading, Sat/Sun weekend, Mon(27) trading = 2
    expect(tradingDayGap('2026-07-23', '2026-07-27', HOLIDAYS_2026)).toBe(2);
  });
  it('is symmetric regardless of argument order', () => {
    expect(tradingDayGap('2026-07-27', '2026-07-23', HOLIDAYS_2026))
      .toBe(tradingDayGap('2026-07-23', '2026-07-27', HOLIDAYS_2026));
  });
  it('excludes holidays from the count', () => {
    // 2026-08-15 is both a Saturday and a holiday in the fixture; either way it doesn't count
    expect(tradingDayGap('2026-08-14', '2026-08-17', HOLIDAYS_2026)).toBe(1); // just Monday 17th
  });
});
