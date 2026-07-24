/**
 * stage-research (pending -> research): docs/01 §3.2 stage 1, docs/10 §2 ingest precondition,
 * docs/03 §2.1/§2.5 theme research + fallback, docs/10 §7 spend cap. Driver-invoked only
 * (cron-secret auth, docs/09 §2.1) — never user-invokable.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, failRun, chainStage } from '../_shared/pipeline.ts';
import { resolveReadyRunDate } from '../_shared/ingest-precondition.ts';
import { anthropicClient, isSpendCapped, accrueLlmCost, RESEARCH_MODEL } from '../_shared/llm.ts';
import { researchThemeCandidates } from '../_shared/theme-research-llm.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function todayIstIso(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface RunRow { id: string; run_month: string; research_month: string | null }

async function loadRun(supabase: SupabaseClient, runId: string): Promise<RunRow> {
  const { data, error } = await supabase.from('monthly_runs').select('id, run_month, research_month').eq('id', runId).single();
  if (error) throw new Error(`failed to load run ${runId}: ${error.message}`);
  return data as RunRow;
}

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

async function loadInvestableThemeKeys(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from('themes').select('key').eq('investable', true).neq('key', 'broad_core');
  // broad_core never ranks as a satellite theme (docs/03 §2.3) — it's chosen outside scoring, so
  // it has no business being offered to the LLM as a candidate theme either.
  if (error) throw new Error(`failed to load investable theme keys: ${error.message}`);
  return (data as Array<{ key: string }>).map((r) => r.key);
}

interface StoredCandidate {
  theme_key: string;
  thesis: string;
  policy_tailwind_score: number;
  sources: string[];
}

/** docs/03 §2.5: fallback candidate set is every investable theme with a flat neutral policy
 *  score and no thesis/sources (there's nothing to attribute those to). */
function buildFallbackCandidates(investableThemeKeys: readonly string[]): StoredCandidate[] {
  return investableThemeKeys.map((theme_key) => ({
    theme_key, thesis: '', policy_tailwind_score: 2.5, sources: [],
  }));
}

async function loadOrCreateThemeResearch(
  supabase: SupabaseClient,
  runId: string,
  researchMonth: string
): Promise<void> {
  const { data: existing, error: existingErr } = await supabase
    .from('theme_research')
    .select('research_month')
    .eq('research_month', researchMonth)
    .maybeSingle();
  if (existingErr) throw new Error(`failed to check existing theme_research: ${existingErr.message}`);
  if (existing) return; // shared across users (docs/05) — nothing to do, already researched this month

  const investableThemeKeys = await loadInvestableThemeKeys(supabase);
  const todayIso = new Date().toISOString().slice(0, 10);

  let candidates: StoredCandidate[];
  let model: string;

  if (await isSpendCapped(supabase, todayIso)) {
    candidates = buildFallbackCandidates(investableThemeKeys);
    model = 'fallback:spend_cap';
  } else {
    const client = anthropicClient();
    const result = await researchThemeCandidates(client, investableThemeKeys);
    if (result.costUsd > 0) await accrueLlmCost(supabase, runId, result.costUsd);
    if (result.ok) {
      candidates = result.candidates;
      model = RESEARCH_MODEL;
    } else {
      candidates = buildFallbackCandidates(investableThemeKeys);
      model = 'fallback:llm_failure';
    }
  }

  // theme_research.research_month is the primary key; a duplicate-key error here means another
  // run beat us to it in a race (only plausible with >1 concurrent user, out of scope for v1's
  // single owner-user, but handled without erroring the stage) — just re-check and move on.
  const { error: insertErr } = await supabase
    .from('theme_research')
    .insert({ research_month: researchMonth, payload: { candidates }, model, forced: false });
  if (insertErr && insertErr.code !== '23505') {
    throw new Error(`failed to persist theme_research for ${researchMonth}: ${insertErr.message}`);
  }
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'pending');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not pending' });

    try {
      const run = await loadRun(supabase, runId);
      const holidays = await loadHolidays(supabase);

      // Any-day pricing (docs/03 header): look backward for the most recent trading day that
      // already has full price/NAV/TRI coverage, rather than insisting on a fixed target date
      // and waiting for it — ingestion is daily, so this resolves to today-or-yesterday in
      // steady state and only walks further back to paper over a transient gap. A genuine
      // failure here (nothing usable in the lookback window) means a real ingestion problem,
      // not "too early in the day" — no wait/retry, fail immediately.
      const resolved = await resolveReadyRunDate(supabase, holidays, todayIstIso());
      if (!resolved.ready) {
        await failRun(supabase, runId, 'ingest_missing');
        return jsonResponse({ ok: false, failed: true, reason: 'ingest_missing', missing: resolved.missing });
      }
      const runDate = resolved.runDate!;

      await loadOrCreateThemeResearch(supabase, runId, run.run_month);
      await completeStage(supabase, runId, 'research', { research_month: run.run_month, run_date: runDate });
      await chainStage('stage-gate', { runId });
      return jsonResponse({ ok: true, runId, status: 'research', runDate });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
