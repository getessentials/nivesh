/**
 * Theme scoring (docs/03 §2.3, docs/08 §1/§2/§4/§7). Computes S_theme for every theme in the
 * fixed scoring cohort (investable themes excluding broad_core — docs/03 §2.3; the caller passes
 * ALL such themes, not just this run's runtime-eligible ones, so cohort size/membership never
 * drifts month to month — only theme SELECTION is restricted to eligible themes, downstream).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  themeScore, breadthRaw, percentileOf, resolveReturnWindow, diversifyFactor,
  MIN_THEME_COHORT_FOR_RANKING, type SeriesPoint, type HeldEtfSeries,
} from './engine-lib.ts';
import { subtractCalendarMonths } from './shared-lib.ts';
import { loadIndexMeta, loadBenchmarkSeries, loadNavSeries } from './benchmark-series-repo.ts';
import { loadCurrentHoldings } from './holdings-repo.ts';

const MOMENTUM_WINDOW_MONTHS = 6;
const TREND_WINDOW_MONTHS = 12;
const DIVERSIFY_WINDOW_MONTHS = 12; // docs/08 §4: min(1y, common history)

export interface ThemeCandidateInput {
  themeKey: string;
  benchmarkIndex: string;
  eligibleEtfCount: number;
  totalAumCr: number;
  policyTailwind0to5: number;
}

export interface ThemeScoreOutput {
  themeKey: string;
  sTheme: number;
  factorJson: Record<string, unknown>;
}

function daysBackIso(asOfIso: string, days: number): string {
  return new Date(new Date(`${asOfIso}T00:00:00.000Z`).getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function sliceSeriesToWindow(series: readonly SeriesPoint[], sinceDateIso: string): SeriesPoint[] {
  return series.filter((p) => p.d >= sinceDateIso);
}

/**
 * Scores every theme in `candidates` — the caller passes the FULL fixed cohort (docs/03 §2.3),
 * filtering to runtime-eligible themes only when selecting the top N afterward. Returns one
 * `ThemeScoreOutput` per candidate, in the same order.
 */
export async function scoreThemes(
  supabase: SupabaseClient,
  userId: string,
  candidates: readonly ThemeCandidateInput[],
  asOfIso: string,
  holidays: ReadonlySet<string>
): Promise<ThemeScoreOutput[]> {
  if (candidates.length === 0) return [];

  const indexNames = [...new Set(candidates.map((c) => c.benchmarkIndex))];
  const indexMeta = await loadIndexMeta(supabase, indexNames);
  // 3y of history comfortably covers the 12m trend window plus endpoint-tolerance headroom.
  const sinceDate = daysBackIso(asOfIso, 3 * 365);

  const seriesByTheme = new Map<string, SeriesPoint[]>();
  for (const c of candidates) {
    const meta = indexMeta.get(c.benchmarkIndex);
    seriesByTheme.set(c.themeKey, meta ? await loadBenchmarkSeries(supabase, meta, sinceDate) : []);
  }

  // docs/08 §7: "the shrink rule [cohort-wide common-window] governs ETF-level return factors" —
  // THEME momentum/trend resolve INDEPENDENTLY per theme (docs/03 §2.3's own "<12m usable
  // benchmark series -> neutral 0.5" is the only fallback that applies here), never joining a
  // cohort-wide shrunk window the way ETF scoring does.
  const momentumReturns = candidates.map((c) => resolveReturnWindow(seriesByTheme.get(c.themeKey) ?? [], asOfIso, MOMENTUM_WINDOW_MONTHS, holidays)?.returnPct ?? null);
  const trendReturns = candidates.map((c) => resolveReturnWindow(seriesByTheme.get(c.themeKey) ?? [], asOfIso, TREND_WINDOW_MONTHS, holidays)?.returnPct ?? null);

  const cohortSize = candidates.length;
  const smallCohortTag = cohortSize >= 2 && cohortSize < MIN_THEME_COHORT_FOR_RANKING + 2 ? 'small_theme_cohort' : null;

  const resolvedMomentumIdx = momentumReturns.map((r, i) => (r === null ? null : i)).filter((i): i is number => i !== null);
  const momentumPercentileByIdx = new Map(
    percentileOf(resolvedMomentumIdx, (i) => momentumReturns[i]!).map((p) => [p.item, p.percentile])
  );
  const resolvedTrendIdx = trendReturns.map((r, i) => (r === null ? null : i)).filter((i): i is number => i !== null);
  const trendPercentileByIdx = new Map(
    percentileOf(resolvedTrendIdx, (i) => trendReturns[i]!).map((p) => [p.item, p.percentile])
  );

  const eligibleCountPercentiles = percentileOf(candidates, (c) => c.eligibleEtfCount);
  const logAumPercentiles = percentileOf(candidates, (c) => Math.log10(Math.max(c.totalAumCr, 1)));

  // diversify factor (docs/08 §4): frozen current holdings, NAV daily returns, windowed to
  // min(1y, common history) — sliced once here and reused for every theme. Uses the shared
  // calendar-month helper (not a raw 30-day-per-month approximation) so the window matches the
  // same "calendar offset" convention as every other window in the app (docs/08 §2).
  const positions = await loadCurrentHoldings(supabase, userId);
  const diversifySinceDate = subtractCalendarMonths(asOfIso, DIVERSIFY_WINDOW_MONTHS);
  const heldEtfSeries: HeldEtfSeries[] = [];
  for (const position of positions) {
    const totalQty = position.lots.reduce((sum, l) => sum + l.qty, 0);
    if (totalQty <= 0) continue;
    const navSeries = sliceSeriesToWindow(await loadNavSeries(supabase, position.etfId, diversifySinceDate), diversifySinceDate);
    const latestNav = navSeries.length > 0 ? navSeries[navSeries.length - 1]!.value : 0;
    heldEtfSeries.push({ etfId: position.etfId, marketValuePaise: BigInt(Math.round(totalQty * latestNav)), navSeries });
  }

  return candidates.map((c, i) => {
    const momentumPercentile = momentumPercentileByIdx.get(i) ?? 0.5;
    const trendPercentile = trendPercentileByIdx.get(i) ?? 0.5;
    const breadthPercentile = breadthRaw(eligibleCountPercentiles[i]!.percentile, logAumPercentiles[i]!.percentile);

    const themeSeriesSliced = sliceSeriesToWindow(seriesByTheme.get(c.themeKey) ?? [], diversifySinceDate);
    const diversify = diversifyFactor(themeSeriesSliced, heldEtfSeries);

    const sTheme = themeScore({
      policyTailwind0to5: c.policyTailwind0to5,
      momentumPercentile,
      trendPercentile,
      breadthPercentile,
      diversifyScore: diversify.score,
    });

    return {
      themeKey: c.themeKey,
      sTheme,
      factorJson: {
        policyTailwind0to5: c.policyTailwind0to5,
        momentumReturnPct: momentumReturns[i], momentumPercentile,
        trendReturnPct: trendReturns[i], trendPercentile,
        eligibleEtfCount: c.eligibleEtfCount, totalAumCr: c.totalAumCr, breadthPercentile,
        diversify,
        cohortSize,
        tags: [momentumReturns[i] === null ? 'insufficient_history' : null, smallCohortTag].filter((t): t is string => t !== null),
      },
    };
  });
}
