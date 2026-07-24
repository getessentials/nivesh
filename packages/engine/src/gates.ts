/**
 * ETF eligibility gates G1-G7 (docs/03 §3.1, docs/10 §4) and the one-per-index dedup rule
 * (docs/03 §3.3). Each gate is a pure function; `evaluateGates` combines them, collecting every
 * failure reason (an ETF can fail more than one gate at once — all are reported, not just the
 * first).
 */
import { monthsBetween } from './fifo.ts';

export interface GateResult {
  pass: boolean;
  reason?: string;
}

export function gateAum(aumCr: number | null, isThematic: boolean): GateResult {
  if (aumCr === null) return { pass: false, reason: 'missing_aum' };
  const threshold = isThematic ? 50 : 100;
  return aumCr >= threshold ? { pass: true } : { pass: false, reason: 'aum_below_threshold' };
}

/** G2: listed >= 12 months as of `asOfDate`. Null listed_on excludes (never guessed). Shares
 *  `monthsBetween` with docs/04's LTCG classification (fifo.ts) so the two calendar-month
 *  calculations can never silently desync. */
export function gateListedDuration(listedOn: string | null, asOfDate: string): GateResult {
  if (listedOn === null) return { pass: false, reason: 'missing_listing_date' };
  const months = monthsBetween(listedOn, asOfDate);
  return months >= 12 ? { pass: true } : { pass: false, reason: 'listed_under_12_months' };
}

export function gateAdtv(adtvPaise: bigint | null): GateResult {
  const THRESHOLD_PAISE = 25_00_000n * 100n; // ₹25 lakh in paise
  if (adtvPaise === null) return { pass: false, reason: 'missing_adtv' };
  return adtvPaise >= THRESHOLD_PAISE ? { pass: true } : { pass: false, reason: 'adtv_below_threshold' };
}

/** G4: TE <= 2% (SEBI cap), AND <= 2x median same-index-peer TE only when that peer cohort has
 *  >= 3 members (docs/03 §3.1: median of 1-2 is degenerate, absolute cap still applies alone). */
export function gateTrackingError(
  trackingError1y: number | null,
  sameIndexPeerMedianTe: number | null,
  sameIndexPeerCohortSize: number
): GateResult {
  if (trackingError1y === null) return { pass: false, reason: 'missing_tracking_error' };
  if (trackingError1y > 2.0) return { pass: false, reason: 'tracking_error_exceeds_sebi_cap' };
  if (sameIndexPeerCohortSize >= 3 && sameIndexPeerMedianTe !== null && trackingError1y > 2 * sameIndexPeerMedianTe) {
    return { pass: false, reason: 'tracking_error_exceeds_peer_relative_cap' };
  }
  return { pass: true };
}

export function gateTer(terPct: number | null): GateResult {
  if (terPct === null) return { pass: false, reason: 'missing_ter' };
  return terPct <= 1.0 ? { pass: true } : { pass: false, reason: 'ter_exceeds_threshold' };
}

/** G6: 30d avg |premium/discount| <= 1% AND plan-day premium <= 1% (docs/03 §3.1, checked again
 *  at plan time per docs/10 §2's as-of-date note). */
export function gatePremiumDiscount(avg30dPremiumDiscountPct: number | null, planDayPremiumPct: number | null): GateResult {
  if (avg30dPremiumDiscountPct === null || planDayPremiumPct === null) return { pass: false, reason: 'missing_premium_discount' };
  if (Math.abs(avg30dPremiumDiscountPct) > 1.0) return { pass: false, reason: 'avg_premium_discount_exceeds_threshold' };
  if (Math.abs(planDayPremiumPct) > 1.0) return { pass: false, reason: 'plan_day_premium_exceeds_threshold' };
  return { pass: true };
}

/** G7: metrics freshness (docs/10 §4) — as_of within 45 days and required fields present. */
export function gateMetricsFreshness(metricsAsOf: string | null, asOfDate: string): GateResult {
  if (metricsAsOf === null) return { pass: false, reason: 'stale_metrics' };
  const days = Math.round(
    (new Date(`${asOfDate}T00:00:00.000Z`).getTime() - new Date(`${metricsAsOf}T00:00:00.000Z`).getTime()) / 86_400_000
  );
  return days <= 45 ? { pass: true } : { pass: false, reason: 'stale_metrics' };
}

export interface EtfGateInputs {
  aumCr: number | null;
  isThematic: boolean;
  listedOn: string | null;
  adtvPaise: bigint | null;
  trackingError1y: number | null;
  sameIndexPeerMedianTe: number | null;
  sameIndexPeerCohortSize: number;
  terPct: number | null;
  avg30dPremiumDiscountPct: number | null;
  planDayPremiumPct: number | null;
  metricsAsOf: string | null;
  asOfDate: string;
}

export interface EtfGateOutcome {
  eligible: boolean;
  failureReasons: string[];
}

/** Runs all seven gates, collecting EVERY failure reason (not just the first) — the plan card
 *  shows the full excluded-ETF reason list (docs/01 §4 screen 3). */
export function evaluateGates(input: EtfGateInputs): EtfGateOutcome {
  const results = [
    gateAum(input.aumCr, input.isThematic),
    gateListedDuration(input.listedOn, input.asOfDate),
    gateAdtv(input.adtvPaise),
    gateTrackingError(input.trackingError1y, input.sameIndexPeerMedianTe, input.sameIndexPeerCohortSize),
    gateTer(input.terPct),
    gatePremiumDiscount(input.avg30dPremiumDiscountPct, input.planDayPremiumPct),
    gateMetricsFreshness(input.metricsAsOf, input.asOfDate),
  ];
  const failureReasons = results.filter((r) => !r.pass).map((r) => r.reason!);
  return { eligible: failureReasons.length === 0, failureReasons };
}

export interface IndexedPick {
  etfId: number;
  underlyingIndex: string;
  sEtfFinal: number;
  terPct: number;
  aumCr: number;
}

export interface DedupResult<T extends IndexedPick> {
  kept: T[];
  runnersUp: Array<{ pick: T; lostTo: T }>;
}

/**
 * One-per-index rule (docs/03 §3.3): never allocate to two ETFs on the same underlying index —
 * keep the higher-scored one (ties: lower TER, then higher AUM, then lower etfId — docs/03 §3.2),
 * show the loser as a runner-up with which pick it lost to.
 */
export function oneperIndexDedup<T extends IndexedPick>(picks: readonly T[]): DedupResult<T> {
  const byIndex = new Map<string, T[]>();
  for (const p of picks) {
    const arr = byIndex.get(p.underlyingIndex) ?? [];
    arr.push(p);
    byIndex.set(p.underlyingIndex, arr);
  }

  const rank = (a: T, b: T) => {
    if (a.sEtfFinal !== b.sEtfFinal) return b.sEtfFinal - a.sEtfFinal;
    if (a.terPct !== b.terPct) return a.terPct - b.terPct;
    if (a.aumCr !== b.aumCr) return b.aumCr - a.aumCr;
    return a.etfId - b.etfId;
  };

  const kept: T[] = [];
  const runnersUp: Array<{ pick: T; lostTo: T }> = [];
  for (const group of byIndex.values()) {
    const sorted = [...group].sort(rank);
    kept.push(sorted[0]!);
    for (const loser of sorted.slice(1)) runnersUp.push({ pick: loser, lostTo: sorted[0]! });
  }
  return { kept, runnersUp };
}
