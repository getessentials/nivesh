/**
 * Feedback loop (docs/03 §5): status classification, decayed score adjustments, stickiness, and
 * rotation advice. Deliberately NOT reinforcement learning (docs/07 §2) — a transparent,
 * auditable bandit-flavored adjustment instead.
 */

export type FeedbackStatus = 'OUTPERFORM' | 'LAG' | 'INLINE';

/**
 * excess/peerGap are already-computed percentages (the caller derives them from price/TRI/NAV
 * return series per docs/08 §3 — this function only classifies). LAG requires excess <= -3% in
 * BOTH this period and the previous one (docs/03 §5); pass `previousExcessPct = null` for the
 * first-ever observation (can't yet be "2 consecutive").
 */
export function classifyStatus(
  excessPct: number,
  peerGapPct: number,
  previousExcessPct: number | null
): FeedbackStatus {
  if (excessPct >= 1 && peerGapPct >= 0) return 'OUTPERFORM';
  if (excessPct <= -3 && previousExcessPct !== null && previousExcessPct <= -3) return 'LAG';
  return 'INLINE';
}

/**
 * Exact decay recurrence (docs/03 §5, docs/08 §7): adj_t = clamp(adj_{t-1} * 2^(-Δm/6) +
 * increment, -bound, +bound). `previousAdj` is 0 when no prior feedback_scores row exists.
 */
export function decayAdjustment(previousAdj: number, deltaMonths: number, increment: number, bound: number): number {
  if (deltaMonths < 0) {
    // The pipeline invariant is Δm >= 0 (checkpoints only move forward in run_month order); a
    // negative value would flip 2^(-Δm/6) above 1 and AMPLIFY previousAdj instead of decaying
    // it — fail loudly rather than silently produce a backwards-looking adjustment.
    throw new Error(`decayAdjustment: deltaMonths must be >= 0, got ${deltaMonths}`);
  }
  const decayed = previousAdj * Math.pow(2, -deltaMonths / 6) + increment;
  return Math.min(Math.max(decayed, -bound), bound);
}

export const THEME_ADJ_BOUND = 12;
export const ETF_ADJ_BOUND = 8;
export const THEME_INC_MAGNITUDE = 6;
export const ETF_INC_MAGNITUDE = 4;

/** Per-ETF increment: +4/-4/0 by its own status (docs/03 §5). */
export function etfIncrement(status: FeedbackStatus): number {
  if (status === 'OUTPERFORM') return ETF_INC_MAGNITUDE;
  if (status === 'LAG') return -ETF_INC_MAGNITUDE;
  return 0;
}

export interface HeldEtfStatus {
  status: FeedbackStatus;
  marketValuePaise: bigint;
}

/**
 * Theme increment (docs/03 §5): "net" = market-value-weighted majority among the theme's held
 * ETFs. MV(OUTPERFORM) > MV(LAG) -> net OUTPERFORM (+6); MV(LAG) > MV(OUTPERFORM) -> net LAG
 * (-6); equal (including all-INLINE) -> 0. INLINE holdings don't enter either side of the
 * comparison, only its own market value is irrelevant to which side "wins".
 */
export function themeIncrement(heldEtfs: readonly HeldEtfStatus[]): number {
  let mvOutperform = 0n, mvLag = 0n;
  for (const h of heldEtfs) {
    if (h.status === 'OUTPERFORM') mvOutperform += h.marketValuePaise;
    else if (h.status === 'LAG') mvLag += h.marketValuePaise;
  }
  if (mvOutperform > mvLag) return THEME_INC_MAGNITUDE;
  if (mvLag > mvOutperform) return -THEME_INC_MAGNITUDE;
  return 0;
}

/**
 * Stickiness rule (docs/03 §5): an INLINE-or-better (INLINE or OUTPERFORM) incumbent beats a
 * challenger unless the challenger's S_etf_final exceeds the incumbent's by MORE than 8 points.
 * A LAG incumbent gets no stickiness protection here — its fate is governed by the separate
 * rotation rule (`rotationAdvice` below), not this ranking comparison.
 */
export function incumbentWinsStickiness(
  incumbentStatus: FeedbackStatus,
  incumbentSEtfFinal: number,
  challengerSEtfFinal: number
): boolean {
  if (incumbentStatus === 'LAG') return false;
  return challengerSEtfFinal - incumbentSEtfFinal <= 8;
}

export type RotationAdvice = 'hold_to_ltcg' | 'rotate_now';

/**
 * Rotation advice for a LAG-for-2-consecutive-runs incumbent (docs/03 §5): if the lot is within
 * 2 months of its LTCG date (the "10-12 months old" window, generalized to any `ltcgMonths`
 * clock — e.g. 10-12 for the standard 12-month clock), default to "hold to LTCG date, then
 * rotate" UNLESS drawdown vs peers exceeds 10%. Outside that close window (already past LTCG,
 * or still far from it), there's no tax-timing reason to wait — rotate now.
 */
export function rotationAdvice(monthsHeld: number, ltcgMonths: number, drawdownVsPeersPct: number): RotationAdvice {
  const monthsToLtcg = ltcgMonths - monthsHeld;
  const inCloseWindow = monthsToLtcg > 0 && monthsToLtcg <= 2;
  if (inCloseWindow && drawdownVsPeersPct <= 10) return 'hold_to_ltcg';
  return 'rotate_now';
}

/** LAG for 2 consecutive runs triggers a rotation PROPOSAL (docs/03 §5) — distinct from the
 *  advice above, which decides what that proposal recommends. */
export function shouldProposeRotation(consecutiveLagRuns: number): boolean {
  return consecutiveLagRuns >= 2;
}
