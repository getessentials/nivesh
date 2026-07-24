/**
 * diversify factor (docs/03 §2.3, exact construction docs/08 §4): Pearson correlation between a
 * theme's benchmark series daily returns and the user's CURRENT holdings' value-weighted daily NAV
 * returns, over min(1y, common history). Pure — the caller supplies already-fetched series.
 */
import type { SeriesPoint } from './windows.ts';

export const DIVERSIFY_MIN_OVERLAP_TRADING_DAYS = 120;
export const NEUTRAL_DIVERSIFY = 0.5;

/** Daily % returns from a sorted (or unsorted) observation series, keyed by the LATER date of
 *  each consecutive pair (docs/08 §4: "daily returns, NAV-based per ETF"). */
function dailyReturns(series: readonly SeriesPoint[]): Map<string, number> {
  const sorted = [...series].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  const out = new Map<string, number>();
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!, curr = sorted[i]!;
    if (prev.value === 0) continue;
    out.set(curr.d, curr.value / prev.value - 1);
  }
  return out;
}

export interface HeldEtfSeries {
  etfId: number;
  /** current market value, used as the frozen weight for this ETF over the whole window
   *  (docs/08 §4: "frozen current holdings ... composition changes during the window are ignored"). */
  marketValuePaise: bigint;
  navSeries: readonly SeriesPoint[];
}

/**
 * Value-weighted portfolio daily-return series (docs/08 §4): for each date where ALL held ETFs
 * have a return observation, the portfolio return is the current-market-value-weighted sum of
 * their individual daily returns. Dates where any holding is missing a return are dropped
 * entirely (docs/08 §2: "no forward-filling... a missing interior date simply doesn't
 * contribute").
 */
export function valueWeightedPortfolioReturns(holdings: readonly HeldEtfSeries[]): Map<string, number> {
  if (holdings.length === 0) return new Map();
  const totalMv = holdings.reduce((s, h) => s + h.marketValuePaise, 0n);
  if (totalMv === 0n) return new Map();

  const perEtfReturns = holdings.map((h) => ({
    weight: Number(h.marketValuePaise) / Number(totalMv),
    returns: dailyReturns(h.navSeries),
  }));

  // Only dates present in EVERY holding's return series contribute (no partial-composition days).
  const candidateDates = [...perEtfReturns[0]!.returns.keys()];
  const portfolio = new Map<string, number>();
  for (const d of candidateDates) {
    let allPresent = true;
    let weighted = 0;
    for (const { weight, returns } of perEtfReturns) {
      const r = returns.get(d);
      if (r === undefined) { allPresent = false; break; }
      weighted += weight * r;
    }
    if (allPresent) portfolio.set(d, weighted);
  }
  return portfolio;
}

/** Pearson correlation over the dates common to both return maps. Returns null if fewer than 2
 *  overlapping observations exist (correlation is undefined) or either series has zero variance. */
export function pearsonCorrelation(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number | null {
  const commonDates = [...a.keys()].filter((d) => b.has(d));
  const n = commonDates.length;
  if (n < 2) return null;

  const xs = commonDates.map((d) => a.get(d)!);
  const ys = commonDates.map((d) => b.get(d)!);
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;

  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX, dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

export interface DiversifyResult {
  score: number;
  tag: 'ok' | 'insufficient_history' | 'no_holdings';
  overlapTradingDays: number;
}

/**
 * diversify = 1 - |corr(theme series, portfolio NAV daily returns)| (docs/03 §2.3, docs/08 §4).
 * Falls back to neutral 0.5 with the appropriate tag when there are no current holdings, or fewer
 * than 120 overlapping trading-day observations between the theme series and the portfolio series
 * (windowed to min(1y, common history) by the caller via `themeSeries`/`holdings` already being
 * pre-sliced to that window before this function is called).
 */
export function diversifyFactor(
  themeSeries: readonly SeriesPoint[],
  holdings: readonly HeldEtfSeries[]
): DiversifyResult {
  if (holdings.length === 0) {
    return { score: NEUTRAL_DIVERSIFY, tag: 'no_holdings', overlapTradingDays: 0 };
  }
  const themeReturns = dailyReturns(themeSeries);
  const portfolioReturns = valueWeightedPortfolioReturns(holdings);
  const overlap = [...themeReturns.keys()].filter((d) => portfolioReturns.has(d)).length;

  if (overlap < DIVERSIFY_MIN_OVERLAP_TRADING_DAYS) {
    return { score: NEUTRAL_DIVERSIFY, tag: 'insufficient_history', overlapTradingDays: overlap };
  }
  const corr = pearsonCorrelation(themeReturns, portfolioReturns);
  if (corr === null) {
    return { score: NEUTRAL_DIVERSIFY, tag: 'insufficient_history', overlapTradingDays: overlap };
  }
  return { score: 1 - Math.abs(corr), tag: 'ok', overlapTradingDays: overlap };
}
