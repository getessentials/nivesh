/**
 * stage-narrate (allocated -> narrated): docs/01 §3.2 stage 6. Generates the "why this rank"
 * prose for every recommendation_items row via Haiku, from factor_json alone (docs/09 §8). Under
 * the spend cap or on total LLM failure, narratives simply stay null — the UI falls back to the
 * numbers-only factor table (docs/09 §8), the pipeline never blocks on the LLM. Driver-invoked
 * only (docs/09 §2.1).
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure, chainStage } from '../_shared/pipeline.ts';
import { anthropicClient, isSpendCapped, accrueLlmCost } from '../_shared/llm.ts';
import { generateNarratives, type NarrativeItemInput } from '../_shared/narrative-llm.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface ItemRow { id: string; level: 'theme' | 'etf'; theme_key: string; etf_id: number | null; rank: number; score: number; factor_json: unknown }

async function loadItems(supabase: SupabaseClient, runId: string): Promise<ItemRow[]> {
  const { data, error } = await supabase.from('recommendation_items').select('id, level, theme_key, etf_id, rank, score, factor_json').eq('run_id', runId);
  if (error) throw new Error(`failed to load recommendation_items for run ${runId}: ${error.message}`);
  return data as ItemRow[];
}

/** Builds each item's "next lower-ranked item" pointer: globally by rank for theme-level rows,
 *  within the SAME theme_key for etf-level rows (ETF ranks are per-theme, docs/03 §3.2). */
function buildNarrativeInputs(items: readonly ItemRow[]): NarrativeItemInput[] {
  const themeItems = items.filter((i) => i.level === 'theme').sort((a, b) => a.rank - b.rank);
  const etfItemsByTheme = new Map<string, ItemRow[]>();
  for (const i of items.filter((i) => i.level === 'etf')) {
    const arr = etfItemsByTheme.get(i.theme_key) ?? [];
    arr.push(i);
    etfItemsByTheme.set(i.theme_key, arr);
  }
  for (const arr of etfItemsByTheme.values()) arr.sort((a, b) => a.rank - b.rank);

  const inputs: NarrativeItemInput[] = [];
  themeItems.forEach((item, i) => {
    inputs.push({
      id: item.id, level: 'theme', themeKey: item.theme_key, etfId: null, rank: item.rank, score: item.score,
      factorJson: item.factor_json, nextFactorJson: themeItems[i + 1]?.factor_json ?? null,
    });
  });
  for (const arr of etfItemsByTheme.values()) {
    arr.forEach((item, i) => {
      inputs.push({
        id: item.id, level: 'etf', themeKey: item.theme_key, etfId: item.etf_id, rank: item.rank, score: item.score,
        factorJson: item.factor_json, nextFactorJson: arr[i + 1]?.factor_json ?? null,
      });
    });
  }
  return inputs;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'allocated');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at allocated' });

    try {
      const items = await loadItems(supabase, runId);
      const inputs = buildNarrativeInputs(items);
      const todayIso = new Date().toISOString().slice(0, 10);

      let narrativesByItemId = new Map<string, string>();
      if (inputs.length > 0 && !(await isSpendCapped(supabase, todayIso))) {
        const client = anthropicClient();
        const result = await generateNarratives(client, inputs);
        narrativesByItemId = result.narrativesByItemId;
        if (result.costUsd > 0) await accrueLlmCost(supabase, runId, result.costUsd);
      }

      for (const [itemId, text] of narrativesByItemId) {
        const { error } = await supabase.from('recommendation_items').update({ narrative: text }).eq('id', itemId);
        if (error) throw new Error(`failed to persist narrative for item ${itemId}: ${error.message}`);
      }

      await completeStage(supabase, runId, 'narrated');
      await chainStage('stage-finalize', { runId });
      return jsonResponse({ ok: true, runId, status: 'narrated', narrated: narrativesByItemId.size, total: inputs.length });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
