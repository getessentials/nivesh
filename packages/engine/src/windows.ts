/**
 * Return-window computation (docs/08 §2): endpoint selection with a small trading-day tolerance,
 * cohort-wide common-window shrink, and CAGR. Pure — callers supply the already-fetched series
 * (etf_navs / etf_prices / index_tri rows) and the NSE holiday set; nothing here touches I/O.
 * Windows are calendar-month offsets anchored at the as-of date (docs/08 §2); "trading day" gaps
 * for endpoint tolerance use `tradingDayGap` from @niveshetf/shared so this module shares the one
 * holiday-calendar implementation with the rest of the app.
 */
import { subtractCalendarMonths, tradingDayGap } from '@niveshetf/shared';

export interface SeriesPoint {
  d: string; // 'YYYY-MM-DD'
  value: number;
}

const ENDPOINT_TOLERANCE_TRADING_DAYS = 5;
/** Below this many trading-day observations in a common window, the window is unusable
 *  (docs/08 §2: "a common window < 60 trading days" gets neutral 0.5, tagged insufficient_history). */
export const MIN_USABLE_WINDOW_TRADING_DAYS = 60;

/**
 * Endpoint selection (docs/08 §2): the latest observation on-or-before `nominalDateIso`, but ONLY
 * if it falls within `toleranceTradingDays` of the edge; failing that, the earliest observation
 * after the edge within the same tolerance. Returns null if neither resolves.
 */
export function selectEndpointObservation(
  series: readonly SeriesPoint[],
  nominalDateIso: string,
  holidays: ReadonlySet<string>,
  toleranceTradingDays = ENDPOINT_TOLERANCE_TRADING_DAYS
): SeriesPoint | null {
  const sorted = [...series].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

  let bestBefore: SeriesPoint | null = null;
  for (const obs of sorted) {
    if (obs.d <= nominalDateIso) bestBefore = obs;
    else break;
  }
  if (bestBefore && tradingDayGap(bestBefore.d, nominalDateIso, holidays) <= toleranceTradingDays) {
    return bestBefore;
  }

  for (const obs of sorted) {
    if (obs.d <= nominalDateIso) continue;
    if (tradingDayGap(nominalDateIso, obs.d, holidays) <= toleranceTradingDays) return obs;
    break; // sorted ascending — the first after-edge candidate is the closest; if it's already
    // outside tolerance, every later one is farther still.
  }
  return null;
}

export interface ResolvedWindow {
  start: SeriesPoint;
  end: SeriesPoint;
  /** count of series observations strictly between start and end, inclusive of both endpoints,
   *  minus 1 — the "trading-day intervals" denominator for CAGR (docs/08 §2). */
  intervals: number;
  returnPct: number;
}

/**
 * Resolves the return between two ARBITRARY dates (not a calendar-offset nominal window) using
 * the same endpoint-selection tolerance rule (docs/08 §2). Used for "since buy" windows (docs/03
 * §5's feedback holding return, and the same rule anchoring docs/08 §2's own cross-reference to
 * "since buy" windows) where the start date is a fixed lot buy date, not `asOf` minus N months.
 */
export function resolveReturnBetweenDates(
  series: readonly SeriesPoint[],
  startDateIso: string,
  endDateIso: string,
  holidays: ReadonlySet<string>
): ResolvedWindow | null {
  const start = selectEndpointObservation(series, startDateIso, holidays);
  const end = selectEndpointObservation(series, endDateIso, holidays);
  if (!start || !end || start.d >= end.d || start.value === 0) return null;

  const sorted = [...series].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const between = sorted.filter((p) => p.d >= start.d && p.d <= end.d);
  const intervals = between.length - 1;
  if (intervals <= 0) return null;

  const returnPct = (end.value / start.value - 1) * 100;
  return { start, end, intervals, returnPct };
}

/**
 * Resolves a calendar-month return window ending at `asOfIso` (docs/08 §2: "windows are calendar
 * offsets anchored at the as-of date"). Returns null if either endpoint is unresolvable.
 */
export function resolveReturnWindow(
  series: readonly SeriesPoint[],
  asOfIso: string,
  windowMonths: number,
  holidays: ReadonlySet<string>
): ResolvedWindow | null {
  return resolveReturnBetweenDates(series, subtractCalendarMonths(asOfIso, windowMonths), asOfIso, holidays);
}

/** CAGR (docs/08 §2): `(end/start)^(252/d) - 1`, d = trading-day intervals between endpoints. */
export function computeCagrPct(startValue: number, endValue: number, intervals: number): number {
  if (intervals <= 0) throw new Error(`computeCagrPct: intervals must be > 0, got ${intervals}`);
  if (startValue <= 0) throw new Error(`computeCagrPct: startValue must be positive, got ${startValue}`);
  return (Math.pow(endValue / startValue, 252 / intervals) - 1) * 100;
}

export interface CommonWindowMember<K> {
  key: K;
  series: readonly SeriesPoint[];
}

export interface CommonWindowResult<K> {
  /** the shrunk window (in months) that was actually achievable across every member; null if the
   *  cohort has no usable common window (< MIN_USABLE_WINDOW_TRADING_DAYS trading-day intervals). */
  usableWindowMonths: number | null;
  perMember: Map<K, ResolvedWindow | null>;
}

/**
 * Cohort-wide common-window shrink (docs/08 §2): tries `nominalMonths`; if any member fails to
 * resolve at that window, steps the window down (in whole months) until every member resolves or
 * the window becomes unusably short. All members are then re-resolved at the SAME final window so
 * returns stay comparable across the cohort.
 */
export function resolveCommonWindow<K>(
  members: readonly CommonWindowMember<K>[],
  asOfIso: string,
  nominalMonths: number,
  holidays: ReadonlySet<string>
): CommonWindowResult<K> {
  for (let months = nominalMonths; months >= 1; months--) {
    const perMember = new Map<K, ResolvedWindow | null>();
    let allResolved = true;
    for (const m of members) {
      const w = resolveReturnWindow(m.series, asOfIso, months, holidays);
      perMember.set(m.key, w);
      if (!w || w.intervals < MIN_USABLE_WINDOW_TRADING_DAYS) allResolved = false;
    }
    if (allResolved) return { usableWindowMonths: months, perMember };
  }
  // No window (down to 1 month) resolves for every member — report unresolved for all.
  const perMember = new Map<K, ResolvedWindow | null>();
  for (const m of members) perMember.set(m.key, null);
  return { usableWindowMonths: null, perMember };
}
