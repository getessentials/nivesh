/**
 * Feedback score computation (docs/03 §5) — status classification + decayed theme/ETF
 * adjustments, computed and persisted at the START of the theme-rank stage (docs/10 §3), before
 * any ranking reads `feedback_scores`. Per-lot excess/peerGap aggregate value-weighted to the
 * holding (docs/03 §5); return bases follow docs/08 §3 (holding leg = exchange price since buy,
 * benchmark = TRI, peer legs = NAV).
 *
 * Simplification (flagged for review): the peer cohort for `peerGap` is every OTHER active ETF
 * sharing the held ETF's `underlying_index` — docs/03 §3.2's "same-index, else theme-cohort,
 * <4 falls back to full universe" percentile-degeneracy rule is about SCORING percentiles, not
 * spelled out for this median comparison, so it isn't replicated here; an index with no peers
 * simply contributes peerGap=0 (neutral) rather than blocking classification.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  monthsBetween, classifyStatus, decayAdjustment, etfIncrement, themeIncrement,
  THEME_ADJ_BOUND, ETF_ADJ_BOUND, resolveReturnBetweenDates, type SeriesPoint, type HeldEtfStatus, type FeedbackStatus,
} from './engine-lib.ts';
import { loadCurrentHoldings } from './holdings-repo.ts';
import { loadIndexMeta, loadBenchmarkSeries, loadNavSeries, loadPriceSeries } from './benchmark-series-repo.ts';

interface PreviousFeedback { adj: number; asOf: string }

async function loadPreviousFeedback(
  supabase: SupabaseClient, userId: string, scope: 'theme' | 'etf', ref: string, beforeAsOf: string
): Promise<PreviousFeedback | null> {
  const { data, error } = await supabase
    .from('feedback_scores')
    .select('adj, as_of')
    .eq('user_id', userId).eq('scope', scope).eq('ref', ref)
    .lt('as_of', beforeAsOf)
    .order('as_of', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`failed to load previous feedback_scores (${scope}/${ref}): ${error.message}`);
  if (!data) return null;
  const row = data as { adj: string | number; as_of: string };
  return { adj: Number(row.adj), asOf: row.as_of };
}

/** Most recent excess%, from `detail`, strictly before `beforeAsOf` — needed for the "2
 *  consecutive LAG runs" classification rule (docs/03 §5). Returns null (not just "no row") when
 *  the most recent row isn't the IMMEDIATELY preceding calendar month — if an intervening month's
 *  run never completed (no feedback_scores row persisted), that's a gap, not two adjacent
 *  observations, and must not be compared as if they were consecutive. */
async function loadPreviousExcessPct(supabase: SupabaseClient, userId: string, etfId: number, beforeAsOf: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('feedback_scores')
    .select('as_of, detail')
    .eq('user_id', userId).eq('scope', 'etf').eq('ref', String(etfId))
    .lt('as_of', beforeAsOf)
    .order('as_of', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`failed to load previous excess for etf ${etfId}: ${error.message}`);
  if (!data) return null;
  const row = data as { as_of: string; detail: { excessPct?: number } };
  if (monthsBetween(row.as_of, beforeAsOf) !== 1) return null;
  return typeof row.detail?.excessPct === 'number' ? row.detail.excessPct : null;
}

async function loadPeerEtfIds(supabase: SupabaseClient, underlyingIndex: string, excludeEtfId: number): Promise<number[]> {
  const { data, error } = await supabase.from('etfs').select('id').eq('underlying_index', underlyingIndex).eq('active', true).neq('id', excludeEtfId);
  if (error) throw new Error(`failed to load peer ETFs for index ${underlyingIndex}: ${error.message}`);
  return (data as Array<{ id: number }>).map((r) => r.id);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

async function computeLatestClosePaise(supabase: SupabaseClient, etfId: number, runDate: string): Promise<bigint | null> {
  const { data, error } = await supabase.from('etf_prices').select('close_paise').eq('etf_id', etfId).lte('d', runDate).order('d', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`failed to load latest close for etf ${etfId}: ${error.message}`);
  return data ? BigInt((data as { close_paise: string }).close_paise) : null;
}

export interface HeldEtfFeedback {
  etfId: number;
  status: FeedbackStatus;
  marketValuePaise: bigint;
  excessPct: number;
  peerGapPct: number;
}

export interface FeedbackComputationResult {
  etfResults: HeldEtfFeedback[];
  /** theme_key -> new decayed theme_adj (docs/03 §5); only themes with >=1 currently-held mapped
   *  ETF get a row (an unheld theme has nothing to compute an increment from). */
  themeAdjByKey: Map<string, number>;
  etfAdjByEtfId: Map<number, number>;
}

/**
 * Computes and PERSISTS this run's feedback_scores rows (docs/03 §5), and returns the resulting
 * adjustments for immediate use by theme/ETF scoring in the same stage. `asOf` is the run's
 * `run_month` (docs/08 §7: decay Δm is calendar months between run_month values); `runDate` is the
 * actual trading day used to select price/NAV/TRI observations.
 */
export async function computeAndPersistFeedback(
  supabase: SupabaseClient,
  userId: string,
  asOf: string,
  runDate: string,
  themeEtfMap: ReadonlyMap<string, readonly number[]>, // theme_key -> mapped etf ids (from theme_etf_map)
  holidays: ReadonlySet<string>
): Promise<FeedbackComputationResult> {
  const holdings = await loadCurrentHoldings(supabase, userId);
  const etfResults: HeldEtfFeedback[] = [];

  if (holdings.length > 0) {
    const uniqueIndices = [...new Set(holdings.map((h) => h.underlyingIndex))];
    const indexMeta = await loadIndexMeta(supabase, uniqueIndices);
    const earliestBuy = holdings.flatMap((h) => h.lots.map((l) => l.buyDate)).sort()[0]!;

    const benchmarkCache = new Map<string, SeriesPoint[]>();
    for (const idx of uniqueIndices) {
      const meta = indexMeta.get(idx);
      benchmarkCache.set(idx, meta ? await loadBenchmarkSeries(supabase, meta, earliestBuy) : []);
    }

    for (const position of holdings) {
      const priceSeries = await loadPriceSeries(supabase, position.etfId, earliestBuy);
      const benchmarkSeries = benchmarkCache.get(position.underlyingIndex) ?? [];
      const peerIds = await loadPeerEtfIds(supabase, position.underlyingIndex, position.etfId);
      const peerNavSeriesById = new Map<number, SeriesPoint[]>();
      for (const peerId of peerIds) peerNavSeriesById.set(peerId, await loadNavSeries(supabase, peerId, earliestBuy));

      const latestClose = await computeLatestClosePaise(supabase, position.etfId, runDate);
      if (latestClose === null) continue; // no price data at all for this ETF at run date — skip, nothing to score

      let weightedExcess = 0, weightedPeerGap = 0, totalMv = 0n;
      for (const lot of position.lots) {
        const holdingWindow = resolveReturnBetweenDates(priceSeries, lot.buyDate, runDate, holidays);
        const benchmarkWindow = resolveReturnBetweenDates(benchmarkSeries, lot.buyDate, runDate, holidays);
        if (!holdingWindow || !benchmarkWindow) continue;

        const peerReturns: number[] = [];
        for (const series of peerNavSeriesById.values()) {
          const w = resolveReturnBetweenDates(series, lot.buyDate, runDate, holidays);
          if (w) peerReturns.push(w.returnPct);
        }
        const peerMedian = median(peerReturns) ?? holdingWindow.returnPct; // no peers -> peerGap=0

        const lotMv = BigInt(lot.qty) * latestClose;
        totalMv += lotMv;
        weightedExcess += Number(lotMv) * (holdingWindow.returnPct - benchmarkWindow.returnPct);
        weightedPeerGap += Number(lotMv) * (holdingWindow.returnPct - peerMedian);
      }
      if (totalMv === 0n) continue;

      const excessPct = weightedExcess / Number(totalMv);
      const peerGapPct = weightedPeerGap / Number(totalMv);
      const previousExcessPct = await loadPreviousExcessPct(supabase, userId, position.etfId, asOf);
      const status = classifyStatus(excessPct, peerGapPct, previousExcessPct);

      etfResults.push({ etfId: position.etfId, status, marketValuePaise: totalMv, excessPct, peerGapPct });
    }
  }

  const etfAdjByEtfId = new Map<number, number>();
  for (const r of etfResults) {
    const previous = await loadPreviousFeedback(supabase, userId, 'etf', String(r.etfId), asOf);
    const deltaMonths = previous ? monthsBetween(previous.asOf, asOf) : 0;
    const newAdj = decayAdjustment(previous?.adj ?? 0, deltaMonths, etfIncrement(r.status), ETF_ADJ_BOUND);
    etfAdjByEtfId.set(r.etfId, newAdj);

    const { error } = await supabase.from('feedback_scores').upsert({
      user_id: userId, scope: 'etf', ref: String(r.etfId), adj: newAdj, as_of: asOf,
      detail: { excessPct: r.excessPct, peerGapPct: r.peerGapPct, status: r.status, marketValuePaise: r.marketValuePaise.toString() },
    }, { onConflict: 'user_id,scope,ref,as_of' });
    if (error) throw new Error(`failed to persist etf feedback_scores for etf ${r.etfId}: ${error.message}`);
  }

  const heldByEtf = new Map(etfResults.map((r) => [r.etfId, r]));
  const themeAdjByKey = new Map<string, number>();
  for (const [themeKey, etfIds] of themeEtfMap) {
    const heldEtfs: HeldEtfStatus[] = etfIds
      .map((id) => heldByEtf.get(id))
      .filter((r): r is HeldEtfFeedback => r !== undefined)
      .map((r) => ({ status: r.status, marketValuePaise: r.marketValuePaise }));
    if (heldEtfs.length === 0) continue; // nothing held in this theme -> no increment to compute

    const previous = await loadPreviousFeedback(supabase, userId, 'theme', themeKey, asOf);
    const deltaMonths = previous ? monthsBetween(previous.asOf, asOf) : 0;
    const newAdj = decayAdjustment(previous?.adj ?? 0, deltaMonths, themeIncrement(heldEtfs), THEME_ADJ_BOUND);
    themeAdjByKey.set(themeKey, newAdj);

    const { error } = await supabase.from('feedback_scores').upsert({
      user_id: userId, scope: 'theme', ref: themeKey, adj: newAdj, as_of: asOf,
      detail: { heldEtfCount: heldEtfs.length },
    }, { onConflict: 'user_id,scope,ref,as_of' });
    if (error) throw new Error(`failed to persist theme feedback_scores for theme ${themeKey}: ${error.message}`);
  }

  return { etfResults, themeAdjByKey, etfAdjByEtfId };
}
