/**
 * Client-side rotation-advice computation (docs/03 §5, docs/01 §3.3/§4: "Screen 4 ... carry
 * feedback badges, days-to-LTCG, and rotation advice"). Uses the SAME `rotationAdvice` /
 * `shouldProposeRotation` / `monthsBetween` pure functions the pipeline would use, fed by data
 * already available client-side (feedback_scores history + the FIFO lot walk) — there is no
 * server-side rotation-proposal persistence yet (tracked as an open item), so this recomputes it
 * from the same inputs rather than leaving screen 4 without the requirement entirely.
 */
import {
  monthsBetween, rotationAdvice, shouldProposeRotation, resolveTaxConfig,
  type Lot, type TaxConfigRow, type AssetClass, type RotationAdvice,
} from '@niveshetf/engine';
import type { FeedbackScoreRow } from '@/types/db';

/** ltcg_months = 1200 is the seed's sentinel for "LTCG unreachable, always slab-taxed" (docs/04). */
const LTCG_UNREACHABLE_SENTINEL = 1200;

/** Adds calendar months, clamping to the last day of the target month on overflow (e.g. 29-Feb
 *  of a leap year + 12 months lands on 28-Feb, not 1-Mar — `Date.setUTCMonth` alone rolls over). */
function addMonthsIso(dateIso: string, months: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  const targetMonth = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  d.setUTCMonth(targetMonth, 1); // pin to the 1st first so setting the day never itself overflows into the month after
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(fromIso: string, toIso: string): number {
  return Math.round((new Date(`${toIso}T00:00:00.000Z`).getTime() - new Date(`${fromIso}T00:00:00.000Z`).getTime()) / 86_400_000);
}

export function resolveLtcgMonths(
  taxConfigs: readonly TaxConfigRow[],
  assetClass: AssetClass,
  etfLtcgMonthsOverride: number | null,
  todayIso: string
): number {
  if (etfLtcgMonthsOverride !== null) return etfLtcgMonthsOverride;
  return resolveTaxConfig(taxConfigs, assetClass, todayIso, todayIso).ltcgMonths;
}

export interface NearestLtcgLot {
  lotId: string;
  buyDate: string;
  daysToLtcg: number; // <= 0 means this lot has already reached (or passed) its LTCG date
}

/** The lot with the soonest still-upcoming LTCG milestone; if every lot has already crossed it,
 *  returns the most-recently-crossed one instead (still informative — "past LTCG"). */
export function nearestLtcgLot(lots: readonly Lot[], ltcgMonths: number, todayIso: string): NearestLtcgLot | null {
  if (lots.length === 0) return null;
  const withDays = lots.map((l) => ({
    lotId: l.id, buyDate: l.buyDate, daysToLtcg: daysBetweenIso(todayIso, addMonthsIso(l.buyDate, ltcgMonths)),
  }));
  const notYet = withDays.filter((l) => l.daysToLtcg > 0).sort((a, b) => a.daysToLtcg - b.daysToLtcg);
  if (notYet.length > 0) return notYet[0]!;
  return withDays.sort((a, b) => b.daysToLtcg - a.daysToLtcg)[0]!;
}

/** Consecutive LAG runs counting back from the most recent `feedback_scores` row (rows must
 *  already be ordered `as_of` descending, as `getFeedbackScores` returns them). */
export function consecutiveLagRuns(etfScoresDesc: readonly FeedbackScoreRow[]): number {
  let n = 0;
  for (const s of etfScoresDesc) {
    const detail = s.detail as { status?: string };
    if (detail.status !== 'LAG') break;
    n++;
  }
  return n;
}

export interface RotationSummary {
  nearest: NearestLtcgLot;
  ltcgUnreachable: boolean;
  consecutiveLagRuns: number;
  proposeRotation: boolean;
  advice: RotationAdvice | null;
}

export function rotationSummary(
  lots: readonly Lot[],
  ltcgMonths: number,
  todayIso: string,
  etfScoresDesc: readonly FeedbackScoreRow[]
): RotationSummary | null {
  const nearest = nearestLtcgLot(lots, ltcgMonths, todayIso);
  if (!nearest) return null;
  const ltcgUnreachable = ltcgMonths >= LTCG_UNREACHABLE_SENTINEL;
  const lagRuns = consecutiveLagRuns(etfScoresDesc);
  const proposeRotation = !ltcgUnreachable && shouldProposeRotation(lagRuns);

  let advice: RotationAdvice | null = null;
  if (proposeRotation) {
    const latestDetail = (etfScoresDesc[0]?.detail ?? {}) as { peerGapPct?: number };
    const drawdownVsPeersPct = typeof latestDetail.peerGapPct === 'number' ? Math.max(0, -latestDetail.peerGapPct) : 0;
    const monthsHeld = monthsBetween(nearest.buyDate, todayIso);
    advice = rotationAdvice(monthsHeld, ltcgMonths, drawdownVsPeersPct);
  }

  return { nearest, ltcgUnreachable, consecutiveLagRuns: lagRuns, proposeRotation, advice };
}
