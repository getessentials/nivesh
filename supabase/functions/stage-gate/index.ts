/**
 * stage-gate (research -> gated): docs/03 §2.2/§3.1 investability + ETF eligibility gates.
 * Evaluates every (theme, mapped ETF) pair with packages/engine's `evaluateGates` and persists
 * the result to `run_etf_gate_results` (migration 20260723000007) so downstream stages — which
 * run as separate Edge Function invocations with no shared memory (docs/10 §3) — can read who's
 * eligible without recomputing. Driver-invoked only (docs/09 §2.1).
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, chainStage } from '../_shared/pipeline.ts';
import { loadEtfsForTheme, loadLatestMetrics, loadPlanDayPremiumPct, type EtfRow, type LatestMetricsRow } from '../_shared/etf-metrics-repo.ts';
import { evaluateGates } from '../_shared/engine-lib.ts';
import { firstTradingDayOfMonth } from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

interface ThemeRow { key: string }

async function loadInvestableThemes(supabase: SupabaseClient): Promise<ThemeRow[]> {
  const { data, error } = await supabase.from('themes').select('key').eq('investable', true);
  if (error) throw new Error(`failed to load investable themes: ${error.message}`);
  return data as ThemeRow[];
}

async function loadAllActiveEtfsWithMetrics(
  supabase: SupabaseClient,
  asOfDate: string
): Promise<{ etfs: EtfRow[]; metrics: Map<number, LatestMetricsRow> }> {
  const { data, error } = await supabase.from('etfs').select('id, underlying_index, asset_class, listed_on, active').eq('active', true);
  if (error) throw new Error(`failed to load active etfs: ${error.message}`);
  const etfs = data as EtfRow[];
  const metrics = await loadLatestMetrics(supabase, etfs.map((e) => e.id), asOfDate);
  return { etfs, metrics };
}

/** Per-underlying-index tracking-error peer cohort (docs/03 §3.1 G4) — computed ONCE across the
 *  whole active universe, since the one-per-index rule (and this peer cohort) spans every theme,
 *  not just one theme's mapped ETFs. */
function buildTePeerCohorts(etfs: readonly EtfRow[], metrics: ReadonlyMap<number, LatestMetricsRow>): Map<string, { median: number | null; size: number }> {
  const byIndex = new Map<string, number[]>();
  for (const etf of etfs) {
    const te = metrics.get(etf.id)?.tracking_error_1y;
    if (te === null || te === undefined) continue;
    const arr = byIndex.get(etf.underlying_index) ?? [];
    arr.push(te);
    byIndex.set(etf.underlying_index, arr);
  }
  const cohorts = new Map<string, { median: number | null; size: number }>();
  for (const [index, tes] of byIndex) cohorts.set(index, { median: median(tes), size: tes.length });
  return cohorts;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'research');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at research' });

    try {
      const { data: runRow, error: runErr } = await supabase.from('monthly_runs').select('run_month').eq('id', runId).single();
      if (runErr) throw new Error(`failed to load run ${runId}: ${runErr.message}`);
      const runMonth = (runRow as { run_month: string }).run_month;

      const { data: holidayRows, error: holidayErr } = await supabase.from('nse_holidays').select('d');
      if (holidayErr) throw new Error(`failed to load nse_holidays: ${holidayErr.message}`);
      const holidays = new Set((holidayRows as Array<{ d: string }>).map((r) => r.d));
      const runDate = firstTradingDayOfMonth(runMonth.slice(0, 7), holidays);

      const { etfs, metrics } = await loadAllActiveEtfsWithMetrics(supabase, runDate);
      const teCohorts = buildTePeerCohorts(etfs, metrics);
      const planDayPremium = await loadPlanDayPremiumPct(supabase, etfs.map((e) => e.id), runDate);
      const etfById = new Map(etfs.map((e) => [e.id, e]));

      const themes = await loadInvestableThemes(supabase);
      const gateRows: Array<{ run_id: string; etf_id: number; theme_key: string; eligible: boolean; failure_reasons: string[] }> = [];

      for (const theme of themes) {
        const mapped = await loadEtfsForTheme(supabase, theme.key);
        const isThematic = theme.key !== 'broad_core';
        for (const mappedEtf of mapped) {
          const etf = etfById.get(mappedEtf.id) ?? mappedEtf;
          const m = metrics.get(etf.id);
          const teCohort = teCohorts.get(etf.underlying_index) ?? { median: null, size: 0 };
          const outcome = evaluateGates({
            aumCr: m?.aum_cr ?? null,
            isThematic,
            listedOn: etf.listed_on,
            adtvPaise: m?.adtv_paise ?? null,
            trackingError1y: m?.tracking_error_1y ?? null,
            sameIndexPeerMedianTe: teCohort.median,
            sameIndexPeerCohortSize: teCohort.size,
            terPct: m?.ter_pct ?? null,
            avg30dPremiumDiscountPct: m?.premium_discount_30d ?? null,
            planDayPremiumPct: planDayPremium.get(etf.id) ?? null,
            metricsAsOf: m?.as_of ?? null,
            asOfDate: runDate,
          });
          gateRows.push({
            run_id: runId, etf_id: etf.id, theme_key: theme.key,
            eligible: outcome.eligible, failure_reasons: outcome.failureReasons,
          });
        }
      }

      // Delete-then-insert (docs/10 §3 idempotency requirement) — a retry after a crash between
      // this insert and completeStage must not hit the (run_id, etf_id, theme_key) primary key.
      const { error: deleteErr } = await supabase.from('run_etf_gate_results').delete().eq('run_id', runId);
      if (deleteErr) throw new Error(`failed to clear prior run_etf_gate_results for run ${runId}: ${deleteErr.message}`);
      if (gateRows.length > 0) {
        const { error: insertErr } = await supabase.from('run_etf_gate_results').insert(gateRows);
        if (insertErr) throw new Error(`failed to persist run_etf_gate_results: ${insertErr.message}`);
      }

      await completeStage(supabase, runId, 'gated');
      await chainStage('stage-theme-rank', { runId });
      return jsonResponse({ ok: true, runId, status: 'gated', gateRows: gateRows.length });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
