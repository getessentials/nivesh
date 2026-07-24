/**
 * stage-theme-rank (gated -> theme_ranked): docs/03 §2.3/§2.4/§5, docs/10 §3. Computes and
 * persists feedback_scores FIRST (docs/03 §5: "computed at the START of the theme-rank pipeline
 * stage, before any ranking reads them"), scores the fixed cohort of runtime-eligible investable
 * themes (excluding broad_core — docs/03 §2.3), and writes the top-N theme-level
 * recommendation_items rows. Driver-invoked only (docs/09 §2.1).
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, chainStage } from '../_shared/pipeline.ts';
import { computeAndPersistFeedback } from '../_shared/feedback-engine.ts';
import { scoreThemes, type ThemeCandidateInput } from '../_shared/theme-scoring.ts';
import { themeScoreFinal, themeCountRange, type RiskAppetite } from '../_shared/engine-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RunRow { user_id: string; run_month: string; run_date: string }

async function loadRun(supabase: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await supabase.from('monthly_runs').select('user_id, run_month, run_date').eq('id', runId).single();
  if (error) throw new Error(`failed to load run ${runId}: ${error.message}`);
  return data as RunRow;
}

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

async function loadRiskAppetite(supabase: SupabaseClient, userId: string): Promise<RiskAppetite> {
  const { data, error } = await supabase.from('profiles').select('risk').eq('user_id', userId).single();
  if (error) throw new Error(`failed to load profile for user ${userId}: ${error.message}`);
  return (data as { risk: RiskAppetite }).risk;
}

/** Investable themes EXCLUDING broad_core — the fixed scoring cohort (docs/03 §2.3: "broad_core
 *  never ranks as a satellite"). */
async function loadScoringCohortThemes(supabase: SupabaseClient): Promise<Array<{ key: string; benchmark_index: string }>> {
  const { data, error } = await supabase.from('themes').select('key, benchmark_index').eq('investable', true).neq('key', 'broad_core');
  if (error) throw new Error(`failed to load scoring-cohort themes: ${error.message}`);
  return data as Array<{ key: string; benchmark_index: string }>;
}

async function loadThemeEtfMap(supabase: SupabaseClient, themeKeys: readonly string[]): Promise<Map<string, string[]>> {
  if (themeKeys.length === 0) return new Map();
  const { data, error } = await supabase.from('theme_etf_map').select('theme_key, etf_id').in('theme_key', themeKeys);
  if (error) throw new Error(`failed to load theme_etf_map: ${error.message}`);
  const map = new Map<string, number[]>();
  for (const row of data as Array<{ theme_key: string; etf_id: number }>) {
    const arr = map.get(row.theme_key) ?? [];
    arr.push(row.etf_id);
    map.set(row.theme_key, arr);
  }
  return new Map([...map].map(([k, v]) => [k, v.map(String)]));
}

/** Runtime eligibility per theme (docs/03 §2.2: ">=1 mapped ETF passes ALL gates this run"),
 *  plus the eligible-ETF count and total AUM feeding the breadth factor (docs/03 §2.3). */
async function loadRuntimeEligibility(
  supabase: SupabaseClient,
  runId: string,
  themeKeys: readonly string[]
): Promise<Map<string, { eligibleEtfIds: number[] }>> {
  if (themeKeys.length === 0) return new Map();
  const { data, error } = await supabase
    .from('run_etf_gate_results')
    .select('theme_key, etf_id, eligible')
    .eq('run_id', runId)
    .in('theme_key', themeKeys)
    .eq('eligible', true);
  if (error) throw new Error(`failed to load run_etf_gate_results for run ${runId}: ${error.message}`);

  const byTheme = new Map<string, { eligibleEtfIds: number[] }>();
  for (const row of data as Array<{ theme_key: string; etf_id: number }>) {
    const entry = byTheme.get(row.theme_key) ?? { eligibleEtfIds: [] };
    entry.eligibleEtfIds.push(row.etf_id);
    byTheme.set(row.theme_key, entry);
  }
  return byTheme;
}

async function loadTotalAumCr(supabase: SupabaseClient, etfIds: readonly number[], asOfDate: string): Promise<number> {
  if (etfIds.length === 0) return 0;
  const { data, error } = await supabase.from('etf_metrics').select('etf_id, as_of, aum_cr').in('etf_id', etfIds).lte('as_of', asOfDate).order('as_of', { ascending: false });
  if (error) throw new Error(`failed to load etf_metrics for AUM: ${error.message}`);
  const latestByEtf = new Map<number, number>();
  for (const row of data as Array<{ etf_id: number; aum_cr: number | null }>) {
    if (!latestByEtf.has(row.etf_id) && row.aum_cr !== null) latestByEtf.set(row.etf_id, row.aum_cr);
  }
  return [...latestByEtf.values()].reduce((sum, v) => sum + v, 0);
}

interface ThemeResearchPayload { candidates: Array<{ theme_key: string; policy_tailwind_score: number }> }

async function loadPolicyScores(supabase: SupabaseClient, runMonth: string): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('theme_research').select('payload').eq('research_month', runMonth).maybeSingle();
  if (error) throw new Error(`failed to load theme_research for ${runMonth}: ${error.message}`);
  const payload = (data as { payload: ThemeResearchPayload } | null)?.payload;
  const map = new Map<string, number>();
  for (const c of payload?.candidates ?? []) map.set(c.theme_key, c.policy_tailwind_score);
  return map;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'gated');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at gated' });

    try {
      const run = await loadRun(supabase, runId);
      const holidays = await loadHolidays(supabase);
      const runDate = run.run_date;
      const risk = await loadRiskAppetite(supabase, run.user_id);

      // docs/03 §2.3: the scoring cohort is FIXED — every investable theme excluding broad_core —
      // regardless of the LLM candidate list AND regardless of this run's runtime eligibility.
      // Runtime eligibility (docs/03 §2.2) governs which themes may be SELECTED, not which ones
      // participate in the percentile cohort; filtering the cohort itself would change its size
      // and membership month to month, corrupting every percentile-based factor.
      const cohortThemes = await loadScoringCohortThemes(supabase);
      const eligibility = await loadRuntimeEligibility(supabase, runId, cohortThemes.map((t) => t.key));

      const policyScores = await loadPolicyScores(supabase, run.run_month);

      // Feedback MUST be computed and persisted before any scoring reads it (docs/03 §5, docs/10 §3).
      const themeEtfMapForFeedback = await loadThemeEtfMap(supabase, cohortThemes.map((t) => t.key));
      const themeEtfMapNumeric = new Map([...themeEtfMapForFeedback].map(([k, v]) => [k, v.map(Number)]));
      const feedback = await computeAndPersistFeedback(supabase, run.user_id, run.run_month, runDate, themeEtfMapNumeric, holidays);

      const candidates: ThemeCandidateInput[] = [];
      for (const t of cohortThemes) {
        const eligibleEtfIds = eligibility.get(t.key)?.eligibleEtfIds ?? [];
        const totalAumCr = eligibleEtfIds.length > 0 ? await loadTotalAumCr(supabase, eligibleEtfIds, runDate) : 0;
        candidates.push({
          themeKey: t.key,
          benchmarkIndex: t.benchmark_index,
          eligibleEtfCount: eligibleEtfIds.length,
          totalAumCr,
          policyTailwind0to5: policyScores.get(t.key) ?? 2.5, // neutral for un-named investable themes (docs/03 §2.3)
        });
      }

      const scored = await scoreThemes(supabase, run.user_id, candidates, runDate, holidays);
      const eligibleThemeKeys = new Set(
        cohortThemes.filter((t) => (eligibility.get(t.key)?.eligibleEtfIds.length ?? 0) > 0).map((t) => t.key)
      );
      const ranked = scored
        .filter((s) => eligibleThemeKeys.has(s.themeKey)) // docs/03 §2.2: non-eligible themes "cannot rank"
        .map((s) => ({ ...s, themeAdj: feedback.themeAdjByKey.get(s.themeKey) ?? 0 }))
        .map((s) => ({ ...s, sThemeFinal: themeScoreFinal(s.sTheme, s.themeAdj) }))
        .sort((a, b) => b.sThemeFinal - a.sThemeFinal);

      const { max: maxThemes } = themeCountRange(risk);
      const selected = ranked.slice(0, maxThemes);

      const { error: deleteErr } = await supabase.from('recommendation_items').delete().eq('run_id', runId).eq('level', 'theme');
      if (deleteErr) throw new Error(`failed to clear prior theme recommendation_items for run ${runId}: ${deleteErr.message}`);

      if (selected.length > 0) {
        const rows = selected.map((s, i) => ({
          run_id: runId, level: 'theme', theme_key: s.themeKey, etf_id: null, rank: i + 1,
          score: s.sThemeFinal, factor_json: { ...s.factorJson, sTheme: s.sTheme, themeAdj: s.themeAdj, sThemeFinal: s.sThemeFinal },
        }));
        const { error: insertErr } = await supabase.from('recommendation_items').insert(rows);
        if (insertErr) throw new Error(`failed to insert theme recommendation_items for run ${runId}: ${insertErr.message}`);
      }

      await completeStage(supabase, runId, 'theme_ranked');
      await chainStage('stage-etf-rank', { runId });
      return jsonResponse({ ok: true, runId, status: 'theme_ranked', themesSelected: selected.length });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
