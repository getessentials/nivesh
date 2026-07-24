/**
 * Theme and ETF score formulas (docs/03 §2.3, §3.2). Inputs are already-computed percentiles/
 * factors (docs/08 §1's percentileOf, and the cohort/window plumbing) — this module is the pure
 * weighted-sum arithmetic, not the data orchestration (that belongs to the monthly-run pipeline).
 */

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

export interface ThemeScoreInput {
  /** LLM's 0-5 tailwind score (docs/03 §2.1) — the ONLY LLM-sourced input, capped at 25% of S_theme. */
  policyTailwind0to5: number;
  /** 6m benchmark-series return percentile vs the theme scoring cohort (0-1). */
  momentumPercentile: number;
  /** 12m benchmark-series return percentile (0-1). */
  trendPercentile: number;
  /** 0.5*pct(eligible_etf_count) + 0.5*pct(log10(total_aum_cr)) (docs/08 §7), already computed (0-1). */
  breadthPercentile: number;
  /** 1 - |corr(theme series, portfolio NAV daily returns)| per docs/08 §4 (0-1; 0.5 if no holdings/insufficient history). */
  diversifyScore: number;
}

/** S_theme (docs/03 §2.3), 0-100. */
export function themeScore(input: ThemeScoreInput): number {
  const policy = clamp(input.policyTailwind0to5, 0, 5) / 5;
  return 25 * policy
    + 25 * input.momentumPercentile
    + 20 * input.trendPercentile
    + 15 * input.breadthPercentile
    + 15 * input.diversifyScore;
}

/** S_theme_final = S_theme + theme_adj (docs/03 §2.4). */
export function themeScoreFinal(sTheme: number, themeAdj: number): number {
  return sTheme + themeAdj;
}

export interface EtfScoreInput {
  /** blended per docs/08 §1: 0.6*pct(-|TD_1y|) + 0.4*pct(-|TD_3y|) if TD_3y exists, else pct(-|TD_1y|) alone. */
  trackingQualityPercentile: number;
  liquidityPercentile: number;
  costPercentile: number;
  scalePercentile: number;
  peerReturnPercentile: number;
  momentumPercentile: number;
  /** true if history < 3y (docs/03 §3.2 shortHistoryPenalty). */
  hasShortHistory: boolean;
}

/** S_etf (docs/03 §3.2), 0-100. shortHistoryPenalty applied after summation, before the clamp
 *  (docs/08 §7: "-5 points ... after component summation; S_etf floored at 0 and capped at 100"). */
export function etfScore(input: EtfScoreInput): number {
  const sum = 25 * input.trackingQualityPercentile
    + 20 * input.liquidityPercentile
    + 15 * input.costPercentile
    + 10 * input.scalePercentile
    + 15 * input.peerReturnPercentile
    + 15 * input.momentumPercentile;
  const penalized = input.hasShortHistory ? sum - 5 : sum;
  return clamp(penalized, 0, 100);
}

/** S_etf_final = clamp(S_etf, 0, 100) + etf_adj (docs/03 §3.2) — used for ranking and stickiness. */
export function etfScoreFinal(sEtf: number, etfAdj: number): number {
  return sEtf + etfAdj;
}

/** breadth_raw combination (docs/08 §7): the two percentiles are pre-computed by the caller via
 *  percentileOf over the theme scoring cohort; this just averages them. */
export function breadthRaw(eligibleCountPercentile: number, logAumPercentile: number): number {
  return 0.5 * eligibleCountPercentile + 0.5 * logAumPercentile;
}

/** trackingQuality blend (docs/08 §1): 0.6/0.4 on 1y/3y fidelity percentiles when TD_3y exists,
 *  else the 1y percentile alone. */
export function trackingQualityBlend(td1yPercentile: number, td3yPercentile: number | null): number {
  if (td3yPercentile === null) return td1yPercentile;
  return 0.6 * td1yPercentile + 0.4 * td3yPercentile;
}
