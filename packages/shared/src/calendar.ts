/**
 * NSE trading-day calendar (docs/10 §1). Pure, clock-injected — every function takes dates as
 * explicit ISO strings ('YYYY-MM-DD', UTC-based) or params; nothing here calls Date.now()/new
 * Date() with no args (isomorphic Deno/browser/Node rule, docs/03 header).
 */

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertISO(iso: string): void {
  if (!ISO_RE.test(iso)) throw new Error(`expected 'YYYY-MM-DD', got: ${iso}`);
}

/** Parse an ISO date string as a UTC-midnight Date (avoids local-TZ drift entirely). */
export function parseISO(iso: string): Date {
  assertISO(iso);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return d;
}

export function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDaysISO(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISODate(d);
}

/** 0=Sunday .. 6=Saturday (UTC day-of-week of the date, timezone-safe since we parse at UTC midnight). */
export function dayOfWeekISO(iso: string): number {
  return parseISO(iso).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const dow = dayOfWeekISO(iso);
  return dow === 0 || dow === 6;
}

/** Trading day = Mon-Fri and not in the holiday set (docs/10 §1). */
export function isTradingDay(iso: string, holidays: ReadonlySet<string>): boolean {
  return !isWeekend(iso) && !holidays.has(iso);
}

/**
 * First trading day of the given month (docs/10 §1/§2 — pg_cron can't express this natively,
 * so the scheduled function computes it and no-ops otherwise).
 * @param yyyyMM 'YYYY-MM'
 */
export function firstTradingDayOfMonth(yyyyMM: string, holidays: ReadonlySet<string>): string {
  if (!/^\d{4}-\d{2}$/.test(yyyyMM)) throw new Error(`expected 'YYYY-MM', got: ${yyyyMM}`);
  let candidate = `${yyyyMM}-01`;
  for (let i = 0; i < 31; i++) {
    if (isTradingDay(candidate, holidays)) return candidate;
    candidate = addDaysISO(candidate, 1);
  }
  throw new Error(`no trading day found in ${yyyyMM} (check the holiday calendar)`);
}

/** The trading day strictly before `iso` (any-day pricing, docs/03 header — used to walk
 *  backward from today looking for the most recent trading day with usable market data,
 *  instead of insisting on a fixed calendar target date). */
export function previousTradingDay(iso: string, holidays: ReadonlySet<string>): string {
  let candidate = addDaysISO(iso, -1);
  for (let i = 0; i < 31; i++) {
    if (isTradingDay(candidate, holidays)) return candidate;
    candidate = addDaysISO(candidate, -1);
  }
  throw new Error(`no trading day found before ${iso} within 31 days (check the holiday calendar)`);
}

/** Last Saturday of the given month (docs/10 §2 refresh-metrics cadence). */
export function lastSaturdayOfMonth(yyyyMM: string): string {
  if (!/^\d{4}-\d{2}$/.test(yyyyMM)) throw new Error(`expected 'YYYY-MM', got: ${yyyyMM}`);
  const [y, m] = yyyyMM.split('-').map(Number) as [number, number];
  // day 0 of next month = last day of this month (UTC-safe via Date.UTC arithmetic)
  const lastDay = new Date(Date.UTC(y, m, 0));
  let iso = toISODate(lastDay);
  while (dayOfWeekISO(iso) !== 6) iso = addDaysISO(iso, -1);
  return iso;
}

/** Deadline for the ingest-precondition wait: 12:00 IST on the day after `runDate` (docs/10 §2). */
export function ingestDeadlineUtc(runDateIso: string): Date {
  const nextDay = addDaysISO(runDateIso, 1);
  // 12:00 IST = 06:30 UTC
  return new Date(`${nextDay}T06:30:00.000Z`);
}

/** Subtract whole calendar months from an ISO date, clamping the day to the shorter target
 *  month (e.g. 2026-05-31 minus 1 month -> 2026-04-30, not an overflowed 2026-05-01). Used by
 *  the return-window anchoring in docs/08 §2 ("windows are calendar offsets"). */
export function subtractCalendarMonths(iso: string, months: number): string {
  const d = parseISO(iso);
  const targetMonthIndex = d.getUTCMonth() - months; // may be negative/large; Date.UTC normalizes
  const probe = new Date(Date.UTC(d.getUTCFullYear(), targetMonthIndex, 1));
  const daysInTargetMonth = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), daysInTargetMonth);
  return toISODate(new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth(), day)));
}

/**
 * Count of trading days strictly after `min(fromIso,toIso)` up to and including `max(fromIso,
 * toIso)` (0 when the two dates are equal). Used for the "within N trading days" endpoint
 * tolerance in docs/08 §2 — a small, self-contained gap measure that doesn't require an
 * explicit trading-day index over the whole series.
 */
export function tradingDayGap(fromIso: string, toIso: string, holidays: ReadonlySet<string>): number {
  const [start, end] = fromIso <= toIso ? [fromIso, toIso] : [toIso, fromIso];
  let count = 0;
  let cursor = start;
  while (cursor < end) {
    cursor = addDaysISO(cursor, 1);
    if (isTradingDay(cursor, holidays)) count++;
  }
  return count;
}
