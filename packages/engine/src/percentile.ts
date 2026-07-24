/**
 * Mid-rank (Hazen) percentile scoring (docs/08 §1): pct = (r - 0.5) / n, r = 1-based ascending
 * rank (r=1 for the smallest value) after direction normalization, ties share the mean rank.
 * Degenerate cohorts (n=1, or n<4 for ETF cohorts per docs/08 §1) are the CALLER's
 * responsibility to detect and substitute neutral 0.5 — this module only ranks a cohort as-is.
 */

export interface PercentileResult<T> {
  item: T;
  /** the normalized (direction-adjusted) value that was ranked */
  value: number;
  percentile: number;
}

/**
 * Ranks `items` by `normalize(item)` ascending (mid-rank, ties share the mean rank), returning
 * percentile = (r-0.5)/n for each. `n` = items.length; callers must special-case n <= 1 or a
 * small cohort per docs/08 §1 BEFORE calling this (percentileOf itself just ranks — n=1 would
 * give percentile 0.5 automatically here anyway, which happens to match the degenerate rule).
 */
export function percentileOf<T>(items: readonly T[], normalize: (item: T) => number): PercentileResult<T>[] {
  const n = items.length;
  if (n === 0) return [];

  const withValues = items.map((item) => ({ item, value: normalize(item) }));
  const sorted = [...withValues].sort((a, b) => a.value - b.value);

  // Assign mid-ranks: a run of equal values shares the mean of their 1-based ranks.
  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1]!.value === sorted[i]!.value) j++;
    const meanRank = (i + 1 + j + 1) / 2; // average of 1-based ranks i+1..j+1
    for (let k = i; k <= j; k++) ranks[k] = meanRank;
    i = j + 1;
  }

  const byOriginalOrder = new Map(withValues.map((w, idx) => [w, idx]));
  const results: PercentileResult<T>[] = new Array(n);
  sorted.forEach((entry, idx) => {
    const originalIdx = byOriginalOrder.get(entry)!;
    results[originalIdx] = { item: entry.item, value: entry.value, percentile: (ranks[idx]! - 0.5) / n };
  });
  return results;
}

/** Neutral percentile for a degenerate cohort (docs/08 §1: n=1 -> 0.5, tagged "no_cohort"). */
export const NEUTRAL_PERCENTILE = 0.5;

/** ETF-cohort degeneracy threshold (docs/08 §1 / docs/07 QNT-1): cohort < 4 falls back to a
 *  wider (caller-supplied) universe, tagged "small_cohort". This just names the threshold. */
export const MIN_ETF_COHORT_SIZE = 4;

/** Theme-cohort degeneracy threshold (docs/08 §1): no wider universe exists for themes, so
 *  n in {2,3} computes as-is (tagged "small_theme_cohort" by the caller), n=1 -> neutral 0.5. */
export const MIN_THEME_COHORT_FOR_RANKING = 2;
