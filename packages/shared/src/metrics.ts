/**
 * ETF metrics computable purely from already-ingested price/NAV series (docs/02 §4: ADTV and
 * premium/discount are "computed"; AUM/TER/TE/TD have no clean API and stay manual-assisted).
 * "30d" = 30 trading days with >=20 observations required (docs/08 §2); fewer => insufficient.
 */

export interface PriceObs { d: string; closePaise: bigint; volume: number | null }
export interface NavObs { d: string; navPaise: bigint }

export interface AdtvResult {
  adtvPaise: bigint | null;
  obsCount: number;
  reason?: 'insufficient_data';
}

const WINDOW = 30;
const MIN_OBS = 20;
// 30 trading days is ~42 calendar days across weekends; 45 gives a small holiday-cluster
// margin. This is a HARD cutoff, not just a row-count slice — without it, a gap in the series
// (an outage, a quarantine run) lets "last 30" silently reach back arbitrarily far and blend in
// stale, no-longer-representative data as if it were recent (verified empirically: a 15-obs
// gap let the naive row-count window reach back 44 calendar days for a 30-row slice).
const MAX_LOOKBACK_DAYS = 45;

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00.000Z`).getTime();
  const b = new Date(`${to}T00:00:00.000Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Rows with d > asOf, or d more than MAX_LOOKBACK_DAYS before asOf, are excluded; input need
 *  not be pre-sorted or pre-windowed. */
function lastNOnOrBefore<T extends { d: string }>(rows: readonly T[], asOf: string, n: number): T[] {
  return rows
    .filter((r) => r.d <= asOf && daysBetween(r.d, asOf) <= MAX_LOOKBACK_DAYS)
    .sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0)) // descending
    .slice(0, n);
}

export function computeAdtv(prices: readonly PriceObs[], asOf: string): AdtvResult {
  const window = lastNOnOrBefore(prices, asOf, WINDOW).filter((p) => p.volume != null);
  if (window.length < MIN_OBS) return { adtvPaise: null, obsCount: window.length, reason: 'insufficient_data' };
  const total = window.reduce((sum, p) => sum + p.closePaise * BigInt(p.volume!), 0n);
  return { adtvPaise: total / BigInt(window.length), obsCount: window.length };
}

export interface PremiumDiscountResult {
  avgPct: number | null;
  obsCount: number;
  reason?: 'insufficient_data';
}

export function computePremiumDiscount30d(
  prices: readonly PriceObs[],
  navs: readonly NavObs[],
  asOf: string
): PremiumDiscountResult {
  const navByDate = new Map(navs.map((n) => [n.d, n.navPaise]));
  const matched = lastNOnOrBefore(prices, asOf, prices.length)
    .filter((p) => navByDate.has(p.d))
    .slice(0, WINDOW);

  if (matched.length < MIN_OBS) return { avgPct: null, obsCount: matched.length, reason: 'insufficient_data' };

  const pctSum = matched.reduce((sum, p) => {
    const nav = navByDate.get(p.d)!;
    const pct = (Number(p.closePaise - nav) / Number(nav)) * 100;
    return sum + pct;
  }, 0);
  return { avgPct: pctSum / matched.length, obsCount: matched.length };
}
