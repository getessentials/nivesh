/** Latest close price as of the run date — used by allocation (units = floor(alloc/price)). */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function loadLatestClosePaise(supabase: SupabaseClient, etfIds: readonly number[], asOfDate: string): Promise<Map<number, bigint>> {
  if (etfIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('etf_prices')
    .select('etf_id, d, close_paise')
    .in('etf_id', etfIds)
    .lte('d', asOfDate)
    .order('d', { ascending: false });
  if (error) throw new Error(`failed to load latest prices: ${error.message}`);
  const latest = new Map<number, bigint>();
  for (const row of data as Array<{ etf_id: number; close_paise: string }>) {
    if (!latest.has(row.etf_id)) latest.set(row.etf_id, BigInt(row.close_paise));
  }
  return latest;
}
