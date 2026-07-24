/**
 * ETF scoring (docs/03 §3.2, docs/08 §1). Cohort CONSTRUCTION (same-index tier, theme-cohort
 * tier, full-universe fallback) is the caller's responsibility (stage-etf-rank/index.ts) — this
 * module only scores whatever candidate list it's given, against itself.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  etfScore, etfScoreFinal, trackingQualityBlend, percentileOf, resolveCommonWindow, resolveReturnWindow,
  computeCagrPct, MIN_ETF_COHORT_SIZE, type SeriesPoint,
} from './engine-lib.ts';
import { loadNavSeries } from './benchmark-series-repo.ts';
import type { LatestMetricsRow } from './etf-metrics-repo.ts';

const MOMENTUM_WINDOW_MONTHS = 6;
const PEER_RETURN_WINDOW_MONTHS = 36; // 3y CAGR (docs/03 §3.2); shrinks via resolveCommonWindow if history is shorter

export interface EtfCandidateInput {
  etfId: number;
  underlyingIndex: string;
  metrics: LatestMetricsRow;
}

export interface EtfScoreOutput {
  etfId: number;
  sEtf: number;
  factorJson: Record<string, unknown>;
}

function daysBackIso(asOfIso: string, days: number): string {
  return new Date(new Date(`${asOfIso}T00:00:00.000Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Percentiles a subset of candidates (those with a resolvable value) then maps every candidate
 *  to that percentile, defaulting to neutral 0.5 for the excluded ones (docs/08 §2: "a member too
 *  short even for the common window gets neutral 0.5" — NOT included as a fabricated data point
 *  in the same ranking, which would corrupt every other candidate's percentile). */
function percentileWithExclusions<T>(
  candidates: readonly T[],
  resolve: (item: T) => number | null,
  keyOf: (item: T) => number
): Map<number, number> {
  const resolved = candidates.filter((c) => resolve(c) !== null);
  const percentiles = new Map(percentileOf(resolved, (c) => resolve(c)!).map((p) => [keyOf(p.item), p.percentile]));
  const out = new Map<number, number>();
  for (const c of candidates) out.set(keyOf(c), percentiles.get(keyOf(c)) ?? 0.5);
  return out;
}

/**
 * Scores every ETF in `candidates` against each other (docs/03 §3.2). The caller decides which
 * cohort a given candidate set represents (same-index / theme / full-universe fallback).
 * `navSeriesCache`, if given, is consulted before hitting the DB — the caller (stage-etf-rank)
 * pre-fetches NAV series once for the whole run's eligible universe so that scoring the same
 * cohort under multiple role-themes (or falling back to the full-universe cohort repeatedly)
 * doesn't re-fetch identical series over and over (docs/10 §8 wall-clock budget).
 */
export async function scoreEtfs(
  supabase: SupabaseClient,
  candidates: readonly EtfCandidateInput[],
  asOfIso: string,
  holidays: ReadonlySet<string>,
  navSeriesCache?: Map<number, SeriesPoint[]>
): Promise<EtfScoreOutput[]> {
  if (candidates.length === 0) return [];

  const sinceDate = daysBackIso(asOfIso, PEER_RETURN_WINDOW_MONTHS * 31);
  const navSeriesByEtf = navSeriesCache ?? new Map<number, SeriesPoint[]>();
  for (const c of candidates) {
    if (!navSeriesByEtf.has(c.etfId)) navSeriesByEtf.set(c.etfId, await loadNavSeries(supabase, c.etfId, sinceDate));
  }

  const momentumWindow = resolveCommonWindow(
    candidates.map((c) => ({ key: c.etfId, series: navSeriesByEtf.get(c.etfId) ?? [] })), asOfIso, MOMENTUM_WINDOW_MONTHS, holidays
  );
  const peerReturnWindow = resolveCommonWindow(
    candidates.map((c) => ({ key: c.etfId, series: navSeriesByEtf.get(c.etfId) ?? [] })), asOfIso, PEER_RETURN_WINDOW_MONTHS, holidays
  );

  const momentumReturns = new Map(candidates.map((c) => [c.etfId, momentumWindow.perMember.get(c.etfId)?.returnPct ?? null]));
  const peerReturnCagrs = new Map<number, number | null>();
  for (const c of candidates) {
    const w = peerReturnWindow.perMember.get(c.etfId);
    peerReturnCagrs.set(c.etfId, w ? computeCagrPct(w.start.value, w.end.value, w.intervals) : null);
  }
  // shortHistoryPenalty is a PER-ETF property (docs/03 §3.2: "if history <3y" — the ETF's own
  // history, not the cohort's shrunk comparison window) — resolved independently per ETF here,
  // separately from the cohort-wide peerReturnWindow used for the CAGR comparison above.
  const hasShortHistory = new Map(
    candidates.map((c) => [c.etfId, resolveReturnWindow(navSeriesByEtf.get(c.etfId) ?? [], asOfIso, PEER_RETURN_WINDOW_MONTHS, holidays) === null])
  );

  const td1yPercentiles = percentileOf(candidates, (c) => -Math.abs(c.metrics.tracking_diff_1y ?? 0));
  const withTd3y = candidates.filter((c) => c.metrics.tracking_diff_3y !== null);
  const td3yPercentileByEtf = new Map(
    percentileOf(withTd3y, (c) => -Math.abs(c.metrics.tracking_diff_3y!)).map((p) => [p.item.etfId, p.percentile])
  );
  const liquidityPercentiles = percentileOf(candidates, (c) => Math.log10(Math.max(Number(c.metrics.adtv_paise ?? 1n), 1)));
  const costPercentiles = percentileOf(candidates, (c) => -(c.metrics.ter_pct ?? 0));
  const scalePercentiles = percentileOf(candidates, (c) => Math.log10(Math.max(c.metrics.aum_cr ?? 1, 1)));
  // docs/08 §2: an ETF whose momentum/peerReturn window can't resolve gets neutral 0.5 directly —
  // it must NOT be fed into percentileOf as a fabricated 0% return, which would corrupt the
  // percentile of every OTHER candidate in the cohort.
  const momentumPercentileByEtf = percentileWithExclusions(candidates, (c) => momentumReturns.get(c.etfId) ?? null, (c) => c.etfId);
  const peerReturnPercentileByEtf = percentileWithExclusions(candidates, (c) => peerReturnCagrs.get(c.etfId) ?? null, (c) => c.etfId);

  const cohortSize = candidates.length;
  const smallCohortTag = cohortSize < MIN_ETF_COHORT_SIZE ? 'small_cohort' : null;

  return candidates.map((c, i) => {
    const trackingQualityPercentile = trackingQualityBlend(td1yPercentiles[i]!.percentile, td3yPercentileByEtf.get(c.etfId) ?? null);
    const input = {
      trackingQualityPercentile,
      liquidityPercentile: liquidityPercentiles[i]!.percentile,
      costPercentile: costPercentiles[i]!.percentile,
      scalePercentile: scalePercentiles[i]!.percentile,
      peerReturnPercentile: peerReturnPercentileByEtf.get(c.etfId) ?? 0.5,
      momentumPercentile: momentumPercentileByEtf.get(c.etfId) ?? 0.5,
      hasShortHistory: hasShortHistory.get(c.etfId) ?? true,
    };
    const sEtf = etfScore(input);
    return {
      etfId: c.etfId,
      sEtf,
      factorJson: {
        ...input,
        momentumReturnPct: momentumReturns.get(c.etfId),
        peerReturnCagrPct: peerReturnCagrs.get(c.etfId),
        terPct: c.metrics.ter_pct, aumCr: c.metrics.aum_cr, adtvPaise: c.metrics.adtv_paise?.toString() ?? null,
        trackingDiff1y: c.metrics.tracking_diff_1y, trackingDiff3y: c.metrics.tracking_diff_3y,
        cohortSize,
        tags: [
          smallCohortTag,
          input.hasShortHistory ? 'young_fund' : null,
          momentumReturns.get(c.etfId) === null || peerReturnCagrs.get(c.etfId) === null ? 'insufficient_history' : null,
        ].filter((t): t is string => t !== null),
      },
    };
  });
}

export { etfScoreFinal };
