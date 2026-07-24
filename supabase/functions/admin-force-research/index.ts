/**
 * admin-force-research (docs/09 §2.1 owner-admin functions): re-runs the monthly LLM theme
 * research pass for a given month, overwriting any existing `theme_research` row — the escape
 * hatch for "the cached research for this month is stale/wrong, get a fresh one" without waiting
 * for next month's cron pass. Admin-JWT only (never cron-invocable — this is a manual action).
 *
 * Known gap: cost accrues to no `monthly_runs` row (this call isn't run-scoped), so it does NOT
 * feed the docs/10 §7 monthly cap sum (which is `sum(monthly_runs.llm_cost_usd)`). The pre-call
 * `isSpendCapped` check still guards against calling while already over cap; the cost is returned
 * in the response and logged, but under-counts the true month-to-date spend by whatever this
 * costs. Acceptable for a rare, owner-only manual action; would need a schema change (a
 * non-run-scoped cost ledger) to close properly.
 */
import { verifyAdminJwt } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { handlePreflight, withCors } from '../_shared/cors.ts';
import { anthropicClient, isSpendCapped, RESEARCH_MODEL } from '../_shared/llm.ts';
import { researchThemeCandidates } from '../_shared/theme-research-llm.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function currentCalendarMonth(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.toISOString().slice(0, 7)}-01`;
}

async function loadInvestableThemeKeys(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase.from('themes').select('key').eq('investable', true).neq('key', 'broad_core');
  if (error) throw new Error(`failed to load investable theme keys: ${error.message}`);
  return (data as Array<{ key: string }>).map((r) => r.key);
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    await verifyAdminJwt(req);
    const supabase = createServiceClient();

    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const researchMonth: string = typeof payload.researchMonth === 'string' ? payload.researchMonth : currentCalendarMonth();
    if (!/^\d{4}-\d{2}-01$/.test(researchMonth)) {
      throw new HttpError(400, 'researchMonth must be "YYYY-MM-01"');
    }

    const todayIso = new Date().toISOString().slice(0, 10);
    if (await isSpendCapped(supabase, todayIso)) {
      throw new HttpError(429, 'monthly LLM spend cap reached — cannot force a fresh research pass right now');
    }

    const investableThemeKeys = await loadInvestableThemeKeys(supabase);
    const client = anthropicClient();
    const result = await researchThemeCandidates(client, investableThemeKeys);
    console.log(`admin-force-research: ${researchMonth} cost $${result.costUsd.toFixed(4)} (not counted toward the monthly_runs-summed cap — see file header)`);

    if (!result.ok) {
      throw new HttpError(502, 'LLM research failed on both attempts — theme_research left unchanged');
    }

    const { error: upsertErr } = await supabase
      .from('theme_research')
      .upsert(
        { research_month: researchMonth, payload: { candidates: result.candidates }, model: RESEARCH_MODEL, forced: true },
        { onConflict: 'research_month' }
      );
    if (upsertErr) throw new Error(`failed to upsert theme_research for ${researchMonth}: ${upsertErr.message}`);

    return withCors(jsonResponse({ ok: true, researchMonth, candidateCount: result.candidates.length, costUsd: result.costUsd }));
  } catch (err) {
    return withCors(errorResponse(err));
  }
});
