/** Resolves a theme/index's benchmark series (docs/03 §6, docs/05 nav_proxy convention) — shared
 *  by stage-theme-rank (theme momentum/trend/diversify) and feedback-engine (per-lot benchmark
 *  return since buy), so the two can never resolve "the benchmark for index X" differently. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { SeriesPoint } from './engine-lib.ts';

export interface IndexMeta {
  name: string;
  tri_source: string;
  proxy_etf_id: number | null;
}

export async function loadIndexMeta(supabase: SupabaseClient, indexNames: readonly string[]): Promise<Map<string, IndexMeta>> {
  if (indexNames.length === 0) return new Map();
  const { data, error } = await supabase.from('indices').select('name, tri_source, proxy_etf_id').in('name', indexNames);
  if (error) throw new Error(`failed to load indices metadata: ${error.message}`);
  return new Map((data as IndexMeta[]).map((r) => [r.name, r]));
}

async function loadSeries(supabase: SupabaseClient, table: string, valueColumn: string, filterColumn: string, filterValue: string | number, sinceDate: string): Promise<SeriesPoint[]> {
  // select('*') — a runtime-interpolated column list defeats supabase-js's select-string literal
  // parser (surfaces as a bogus TS2352 conversion error), so we always fetch the whole row.
  const { data, error } = await supabase.from(table).select('*').eq(filterColumn, filterValue).gte('d', sinceDate);
  if (error) throw new Error(`failed to load ${table} series for ${filterColumn}=${filterValue}: ${error.message}`);
  return (data as Array<Record<string, unknown>>).map((r) => ({ d: r.d as string, value: Number(r[valueColumn]) }));
}

/** The benchmark series for an index — its TRI, or (nav_proxy indices) the pinned proxy ETF's NAV
 *  series (docs/05: "nothing is copied into index_tri for nav_proxy indices"). */
export function loadBenchmarkSeries(supabase: SupabaseClient, indexMeta: IndexMeta, sinceDate: string): Promise<SeriesPoint[]> {
  if (indexMeta.tri_source === 'nav_proxy') {
    if (indexMeta.proxy_etf_id === null) return Promise.resolve([]);
    return loadSeries(supabase, 'etf_navs', 'nav_paise', 'etf_id', indexMeta.proxy_etf_id, sinceDate);
  }
  return loadSeries(supabase, 'index_tri', 'value', 'index_name', indexMeta.name, sinceDate);
}

export function loadNavSeries(supabase: SupabaseClient, etfId: number, sinceDate: string): Promise<SeriesPoint[]> {
  return loadSeries(supabase, 'etf_navs', 'nav_paise', 'etf_id', etfId, sinceDate);
}

export function loadPriceSeries(supabase: SupabaseClient, etfId: number, sinceDate: string): Promise<SeriesPoint[]> {
  return loadSeries(supabase, 'etf_prices', 'close_paise', 'etf_id', etfId, sinceDate);
}
