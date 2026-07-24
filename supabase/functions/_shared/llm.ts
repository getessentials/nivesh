/**
 * Anthropic API access point + the global LLM spend cap (docs/10 §7, docs/09 §2.1: "LLM API
 * called ONLY from Edge Functions"). Every stage that calls Claude goes through this module so the
 * cap check and cost accounting happen exactly once, the same way, everywhere.
 */
import Anthropic from '@anthropic-ai/sdk';
import { requireEnv } from './env.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

/** docs/03/CLAUDE.md: Sonnet + web search for monthly theme research; Haiku for narratives. */
export const RESEARCH_MODEL = 'claude-sonnet-5';
export const NARRATIVE_MODEL = 'claude-haiku-4-5';

export function anthropicClient(): Anthropic {
  return new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });
}

/** docs/10 §7: hard global cap, all users/runs/retries, calendar-month scoped. */
export const LLM_MONTHLY_CAP_USD = 2.0;

interface ModelPricingPerMillionTokens {
  input: number;
  output: number;
}

// Deliberately the STANDARD (non-introductory) per-token rate for Sonnet, even though an intro
// discount is in effect through 2026-08-31 — a cap-accounting module should over-, not
// under-estimate spend against a hard $2/month ceiling (docs/10 §7). Update if the standard rate
// itself changes; do not swap in the discounted rate as an "accuracy" fix.
const PRICING: Record<string, ModelPricingPerMillionTokens> = {
  [RESEARCH_MODEL]: { input: 3.0, output: 15.0 },
  [NARRATIVE_MODEL]: { input: 1.0, output: 5.0 },
};

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/** Cache writes/reads priced relative to the base input rate — standard 5-minute-TTL ratios. */
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

export function usageCostUsd(model: string, usage: UsageLike): number {
  const pricing = PRICING[model];
  if (!pricing) throw new Error(`usageCostUsd: no pricing configured for model "${model}"`);
  const inputCost = (usage.input_tokens / 1_000_000) * pricing.input;
  const outputCost = (usage.output_tokens / 1_000_000) * pricing.output;
  const cacheWriteCost = ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) * pricing.input * CACHE_WRITE_MULTIPLIER;
  const cacheReadCost = ((usage.cache_read_input_tokens ?? 0) / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

/** First-of-month for the calendar month containing `dateIso` — the cap-summation key
 *  (docs/10 §7: "sums llm_cost_usd over monthly_runs where run_month = the current calendar
 *  month"; monthly_runs.run_month is always the 1st of its month, so this normalizes any date
 *  to that same key). */
export function calendarMonthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`;
}

function nextMonthStart(monthStartIso: string): string {
  const [y, m] = monthStartIso.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Sum of llm_cost_usd across EVERY user's monthly_runs whose run_month falls in the same
 *  calendar month as `todayIso` (docs/10 §7 — global, not per-user). */
export async function monthToDateLlmSpendUsd(supabase: SupabaseClient, todayIso: string): Promise<number> {
  const monthStart = calendarMonthStart(todayIso);
  const monthEnd = nextMonthStart(monthStart);
  const { data, error } = await supabase
    .from('monthly_runs')
    .select('llm_cost_usd')
    .gte('run_month', monthStart)
    .lt('run_month', monthEnd);
  if (error) throw new Error(`failed to sum llm_cost_usd for spend cap: ${error.message}`);
  return (data as Array<{ llm_cost_usd: number | string }>).reduce((sum, r) => sum + Number(r.llm_cost_usd), 0);
}

/** Checked before EVERY Anthropic call (docs/10 §7) — never after, so an in-flight call can't
 *  push month-to-date spend past the cap before the next call's check runs. */
export async function isSpendCapped(supabase: SupabaseClient, todayIso: string): Promise<boolean> {
  return (await monthToDateLlmSpendUsd(supabase, todayIso)) >= LLM_MONTHLY_CAP_USD;
}

/**
 * Accrues cost onto a specific run's `llm_cost_usd` accumulator (docs/05). Read-then-write rather
 * than an atomic SQL increment: safe because a run's stages execute strictly sequentially under
 * the CAS stage lease (docs/10 §3) — no concurrent writer can race this read/write pair for the
 * same run.
 */
export async function accrueLlmCost(supabase: SupabaseClient, runId: string, additionalUsd: number): Promise<void> {
  const { data, error } = await supabase.from('monthly_runs').select('llm_cost_usd').eq('id', runId).single();
  if (error) throw new Error(`failed to read llm_cost_usd for run ${runId}: ${error.message}`);
  const next = Number((data as { llm_cost_usd: number | string }).llm_cost_usd) + additionalUsd;
  const { error: updErr } = await supabase.from('monthly_runs').update({ llm_cost_usd: next }).eq('id', runId);
  if (updErr) throw new Error(`failed to accrue llm_cost_usd for run ${runId}: ${updErr.message}`);
}
