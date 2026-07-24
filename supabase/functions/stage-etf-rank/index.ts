/**
 * stage-etf-rank (theme_ranked -> etf_ranked): docs/03 §3.1/§3.2/§5. Ranks up to 5 eligible ETFs
 * per role — every selected satellite theme, PLUS broad_core (docs/03 §1: core is chosen
 * deterministically but still scored within its own index), PLUS the profile's non-equity sleeve
 * theme (gold or debt_liquid) — applying the feedback-driven incumbent-stickiness rule (docs/03
 * §5). Cross-theme one-per-index dedup and the within-theme 70/30 split are deferred to
 * stage-allocate, since they decide who actually receives money, not who ranks where (docs/03
 * §3.3/§4). Driver-invoked only (docs/09 §2.1).
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, chainStage } from '../_shared/pipeline.ts';
import { loadLatestMetrics, type LatestMetricsRow } from '../_shared/etf-metrics-repo.ts';
import { scoreEtfs, etfScoreFinal, type EtfCandidateInput } from '../_shared/etf-scoring.ts';
import { loadEtfFeedback } from '../_shared/etf-feedback-repo.ts';
import { incumbentWinsStickiness, MIN_ETF_COHORT_SIZE, type FeedbackStatus, type SeriesPoint } from '../_shared/engine-lib.ts';
import { firstTradingDayOfMonth } from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAX_RANKED_PER_THEME = 5;

interface RunRow { user_id: string; run_month: string }

async function loadRun(supabase: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await supabase.from('monthly_runs').select('user_id, run_month').eq('id', runId).single();
  if (error) throw new Error(`failed to load run ${runId}: ${error.message}`);
  return data as RunRow;
}

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

async function loadProfileSleeveConfig(supabase: SupabaseClient, userId: string): Promise<{ nonEquityTheme: string }> {
  const { data, error } = await supabase.from('profiles').select('non_equity_sleeve').eq('user_id', userId).single();
  if (error) throw new Error(`failed to load profile for user ${userId}: ${error.message}`);
  const sleeve = (data as { non_equity_sleeve: 'gold' | 'debt' }).non_equity_sleeve;
  return { nonEquityTheme: sleeve === 'gold' ? 'gold' : 'debt_liquid' };
}

async function loadSelectedSatelliteThemes(supabase: SupabaseClient, runId: string): Promise<string[]> {
  const { data, error } = await supabase.from('recommendation_items').select('theme_key').eq('run_id', runId).eq('level', 'theme');
  if (error) throw new Error(`failed to load selected themes for run ${runId}: ${error.message}`);
  return (data as Array<{ theme_key: string }>).map((r) => r.theme_key);
}

async function loadHeldEtfIds(supabase: SupabaseClient, userId: string): Promise<Set<number>> {
  const { data, error } = await supabase.from('holdings').select('etf_id').eq('user_id', userId);
  if (error) throw new Error(`failed to load holdings for user ${userId}: ${error.message}`);
  return new Set((data as Array<{ etf_id: number }>).map((r) => r.etf_id));
}

/** Every (theme_key -> eligible etf ids) pair needed this run (docs/03 §2.2 eligibility). */
async function loadEligibleByTheme(supabase: SupabaseClient, runId: string, themeKeys: readonly string[]): Promise<Map<string, number[]>> {
  if (themeKeys.length === 0) return new Map();
  const { data, error } = await supabase.from('run_etf_gate_results').select('theme_key, etf_id').eq('run_id', runId).eq('eligible', true).in('theme_key', themeKeys);
  if (error) throw new Error(`failed to load run_etf_gate_results for run ${runId}: ${error.message}`);
  const map = new Map<string, number[]>();
  for (const row of data as Array<{ theme_key: string; etf_id: number }>) {
    const arr = map.get(row.theme_key) ?? [];
    arr.push(row.etf_id);
    map.set(row.theme_key, arr);
  }
  return map;
}

async function loadUnderlyingIndexByEtf(supabase: SupabaseClient, etfIds: readonly number[]): Promise<Map<number, string>> {
  if (etfIds.length === 0) return new Map();
  const { data, error } = await supabase.from('etfs').select('id, underlying_index').in('id', etfIds);
  if (error) throw new Error(`failed to load etfs underlying_index: ${error.message}`);
  return new Map((data as Array<{ id: number; underlying_index: string }>).map((r) => [r.id, r.underlying_index]));
}

/** Applies the incumbent stickiness rule to reorder a theme's scored candidates (docs/03 §5): if
 *  the incumbent isn't already the top-ranked candidate, and it wins stickiness against whoever
 *  currently is, promote it to rank 1. */
function applyStickiness<T extends { etfId: number; sEtfFinal: number }>(
  sorted: T[],
  heldEtfIds: ReadonlySet<number>,
  feedbackByEtf: ReadonlyMap<number, { status: string }>
): T[] {
  if (sorted.length < 2) return sorted;
  const incumbentIdx = sorted.findIndex((c) => heldEtfIds.has(c.etfId));
  if (incumbentIdx <= 0) return sorted; // no incumbent among candidates, or already ranked first
  const incumbent = sorted[incumbentIdx]!;
  const topChallenger = sorted[0]!;
  const status = feedbackByEtf.get(incumbent.etfId)?.status;
  if (status && incumbentWinsStickiness(status as FeedbackStatus, incumbent.sEtfFinal, topChallenger.sEtfFinal)) {
    const rest = sorted.filter((_, i) => i !== incumbentIdx);
    return [incumbent, ...rest];
  }
  return sorted;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'theme_ranked');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at theme_ranked' });

    try {
      const run = await loadRun(supabase, runId);
      const holidays = await loadHolidays(supabase);
      const runDate = firstTradingDayOfMonth(run.run_month.slice(0, 7), holidays);

      const satelliteThemes = await loadSelectedSatelliteThemes(supabase, runId);
      const { nonEquityTheme } = await loadProfileSleeveConfig(supabase, run.user_id);
      const roleThemes = [...new Set([...satelliteThemes, 'broad_core', nonEquityTheme])];

      const eligibleByTheme = await loadEligibleByTheme(supabase, runId, roleThemes);
      const allEligibleEtfIds = [...new Set([...eligibleByTheme.values()].flat())];
      const underlyingIndexByEtf = await loadUnderlyingIndexByEtf(supabase, allEligibleEtfIds);
      const metricsByEtf = await loadLatestMetrics(supabase, allEligibleEtfIds, runDate);
      const heldEtfIds = await loadHeldEtfIds(supabase, run.user_id);
      const etfFeedback = await loadEtfFeedback(supabase, run.user_id, run.run_month);

      const allCandidates: EtfCandidateInput[] = allEligibleEtfIds
        .filter((id) => underlyingIndexByEtf.has(id) && metricsByEtf.has(id))
        .map((id) => ({ etfId: id, underlyingIndex: underlyingIndexByEtf.get(id)!, metrics: metricsByEtf.get(id)! as LatestMetricsRow }));

      const rowsToInsert: Array<{ run_id: string; level: string; theme_key: string; etf_id: number; rank: number; score: number; factor_json: Record<string, unknown> }> = [];

      // Shared across every scoreEtfs call this invocation — without this, each role-theme (and
      // every full-universe-fallback call) would re-fetch identical 3y NAV series for the same
      // ~30-40 ETFs from scratch, risking the Edge Function wall-clock budget (docs/10 §8).
      const navSeriesCache = new Map<number, SeriesPoint[]>();

      for (const themeKey of roleThemes) {
        const themeEligibleIds = eligibleByTheme.get(themeKey) ?? [];
        if (themeEligibleIds.length === 0) continue;

        // Tier 1 (docs/03 §3.2: "vs peers on the SAME underlying index where possible"): every
        // eligible-this-run ETF (any theme) sharing an underlying index with this theme's own
        // eligible ETFs. Tier 2 (docs/08 §1: "cohort <4 -> full-universe fallback"): every
        // eligible-this-run ETF across the whole run.
        const themeIndices = new Set(allCandidates.filter((c) => themeEligibleIds.includes(c.etfId)).map((c) => c.underlyingIndex));
        let cohort = allCandidates.filter((c) => themeIndices.has(c.underlyingIndex));
        let usedFullUniverseFallback = false;
        if (cohort.length < MIN_ETF_COHORT_SIZE) {
          cohort = allCandidates;
          usedFullUniverseFallback = true;
        }

        const scored = await scoreEtfs(supabase, cohort, runDate, holidays, navSeriesCache);
        const scoredByEtf = new Map(scored.map((s) => [s.etfId, s]));

        const themeScored = themeEligibleIds
          .map((id) => scoredByEtf.get(id))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)
          .map((s) => {
            const adj = etfFeedback.get(s.etfId)?.adj ?? 0;
            return { ...s, etfAdj: adj, sEtfFinal: etfScoreFinal(s.sEtf, adj) };
          });

        const sorted = [...themeScored].sort((a, b) => {
          if (a.sEtfFinal !== b.sEtfFinal) return b.sEtfFinal - a.sEtfFinal;
          const aTer = a.factorJson.terPct as number | null, bTer = b.factorJson.terPct as number | null;
          if ((aTer ?? Infinity) !== (bTer ?? Infinity)) return (aTer ?? Infinity) - (bTer ?? Infinity);
          const aAum = a.factorJson.aumCr as number | null, bAum = b.factorJson.aumCr as number | null;
          if ((bAum ?? 0) !== (aAum ?? 0)) return (bAum ?? 0) - (aAum ?? 0);
          return a.etfId - b.etfId;
        });

        const sticky = applyStickiness(sorted, heldEtfIds, etfFeedback);
        const capped = sticky.slice(0, MAX_RANKED_PER_THEME);

        capped.forEach((s, i) => {
          rowsToInsert.push({
            run_id: runId, level: 'etf', theme_key: themeKey, etf_id: s.etfId, rank: i + 1, score: s.sEtfFinal,
            factor_json: {
              ...s.factorJson, sEtf: s.sEtf, etfAdj: s.etfAdj, sEtfFinal: s.sEtfFinal,
              incumbentSticky: heldEtfIds.has(s.etfId) && i === 0 && sorted[0]?.etfId !== s.etfId,
              tags: [...(s.factorJson.tags as string[]), usedFullUniverseFallback ? 'full_universe_fallback' : null].filter((t): t is string => t !== null),
            },
          });
        });
      }

      const { error: deleteErr } = await supabase.from('recommendation_items').delete().eq('run_id', runId).eq('level', 'etf');
      if (deleteErr) throw new Error(`failed to clear prior etf recommendation_items for run ${runId}: ${deleteErr.message}`);
      if (rowsToInsert.length > 0) {
        const { error: insertErr } = await supabase.from('recommendation_items').insert(rowsToInsert);
        if (insertErr) throw new Error(`failed to insert etf recommendation_items for run ${runId}: ${insertErr.message}`);
      }

      await completeStage(supabase, runId, 'etf_ranked');
      await chainStage('stage-allocate', { runId });
      return jsonResponse({ ok: true, runId, status: 'etf_ranked', rows: rowsToInsert.length });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
