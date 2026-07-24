/**
 * Ingest precondition for the run date (docs/10 §2): before stage-research does anything, prices/
 * NAV/TRI for the RUN DATE must be present. All three legs are checked on data presence, never
 * job status (a job can log ok=true while the source served yesterday's file).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * "or >=90% of them; threshold pinned at seed" (docs/10 §2) — no seed table exists yet for this
 * knob, so it's a code constant here; a future seed config row can replace it without changing
 * the call sites.
 */
const PRICE_NAV_COVERAGE_THRESHOLD = 0.9;

export interface IngestPreconditionResult {
  ready: boolean;
  missing: string[]; // human-readable reasons, for fail_reason / diagnostics
}

async function activeEtfCount(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase.from('etfs').select('id', { count: 'exact', head: true }).eq('active', true);
  if (error) throw new Error(`failed to count active etfs: ${error.message}`);
  return count ?? 0;
}

async function rowCountForDate(supabase: SupabaseClient, table: string, dateColumn: string, runDate: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true }).eq(dateColumn, runDate);
  if (error) throw new Error(`failed to count ${table} rows for ${runDate}: ${error.message}`);
  return count ?? 0;
}

async function usedIndexNames(supabase: SupabaseClient): Promise<string[]> {
  // Every investable theme's benchmark_index, PLUS the fixed core index and every non-nav_proxy
  // ETF's underlying_index the engine might need — but the pipeline's own TRI reads are scoped to
  // themes.benchmark_index (docs/03 §2.3: "every investable theme MUST have a benchmark series"),
  // so that's the precondition's scope too.
  const { data, error } = await supabase.from('themes').select('benchmark_index').eq('investable', true).not('benchmark_index', 'is', null);
  if (error) throw new Error(`failed to load investable themes' benchmark indices: ${error.message}`);
  return [...new Set((data as Array<{ benchmark_index: string }>).map((r) => r.benchmark_index))];
}

async function indexTriCoverage(supabase: SupabaseClient, indexNames: string[], runDate: string): Promise<string[]> {
  if (indexNames.length === 0) return [];
  // nav_proxy indices have no index_tri rows by design (docs/05: "nothing is copied into
  // index_tri for nav_proxy indices" — their series lives in etf_navs of the pinned proxy ETF).
  const { data: proxyRows, error: proxyErr } = await supabase.from('indices').select('name').in('name', indexNames).eq('tri_source', 'nav_proxy');
  if (proxyErr) throw new Error(`failed to load nav_proxy indices: ${proxyErr.message}`);
  const proxyNames = new Set((proxyRows as Array<{ name: string }>).map((r) => r.name));
  const triBackedNames = indexNames.filter((n) => !proxyNames.has(n));
  if (triBackedNames.length === 0) return [];

  const { data, error } = await supabase.from('index_tri').select('index_name').eq('d', runDate).in('index_name', triBackedNames);
  if (error) throw new Error(`failed to check index_tri coverage for ${runDate}: ${error.message}`);
  const present = new Set((data as Array<{ index_name: string }>).map((r) => r.index_name));
  return triBackedNames.filter((n) => !present.has(n));
}

export async function checkIngestPrecondition(supabase: SupabaseClient, runDate: string): Promise<IngestPreconditionResult> {
  const missing: string[] = [];
  const activeCount = await activeEtfCount(supabase);
  if (activeCount > 0) {
    const priceCount = await rowCountForDate(supabase, 'etf_prices', 'd', runDate);
    if (priceCount < activeCount * PRICE_NAV_COVERAGE_THRESHOLD) missing.push(`etf_prices: ${priceCount}/${activeCount} for ${runDate}`);

    const navCount = await rowCountForDate(supabase, 'etf_navs', 'd', runDate);
    if (navCount < activeCount * PRICE_NAV_COVERAGE_THRESHOLD) missing.push(`etf_navs: ${navCount}/${activeCount} for ${runDate}`);
  }

  const indexNames = await usedIndexNames(supabase);
  const missingTri = await indexTriCoverage(supabase, indexNames, runDate);
  if (missingTri.length > 0) missing.push(`index_tri missing for: ${missingTri.join(', ')}`);

  return { ready: missing.length === 0, missing };
}
