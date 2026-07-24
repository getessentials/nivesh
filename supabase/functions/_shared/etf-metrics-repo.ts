/** Loads the latest snapshot fields the ETF eligibility gates need (docs/03 §3.1) — AUM/TER/
 *  tracking-error/ADTV/premium-discount all come straight from the monthly `etf_metrics`
 *  snapshot (docs/02 §4: refresh-metrics computes ADTV/premium-discount; AUM/TER/TE are
 *  manual-assisted). Shared by stage-gate and stage-etf-rank so the two never read this
 *  differently. */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface EtfRow {
  id: number;
  underlying_index: string;
  asset_class: string;
  listed_on: string | null;
  active: boolean;
}

export interface LatestMetricsRow {
  as_of: string;
  aum_cr: number | null;
  ter_pct: number | null;
  tracking_error_1y: number | null;
  tracking_diff_1y: number | null;
  tracking_diff_3y: number | null;
  adtv_paise: bigint | null;
  premium_discount_30d: number | null;
}

/** Two plain queries rather than a PostgREST embedded-resource select (`etfs(...)`) — without
 *  generated Database types the embedding's object-vs-array shape isn't reliably inferable at
 *  compile time, and getting that wrong would silently misread every mapped ETF. */
export async function loadEtfsForTheme(supabase: SupabaseClient, themeKey: string): Promise<EtfRow[]> {
  const { data: mapRows, error: mapErr } = await supabase.from('theme_etf_map').select('etf_id').eq('theme_key', themeKey);
  if (mapErr) throw new Error(`failed to load theme_etf_map for theme ${themeKey}: ${mapErr.message}`);
  const etfIds = (mapRows as Array<{ etf_id: number }>).map((r) => r.etf_id);
  if (etfIds.length === 0) return [];

  const { data, error } = await supabase
    .from('etfs')
    .select('id, underlying_index, asset_class, listed_on, active')
    .in('id', etfIds)
    .eq('active', true);
  if (error) throw new Error(`failed to load ETFs mapped to theme ${themeKey}: ${error.message}`);
  return data as EtfRow[];
}

/** Latest etf_metrics row for each ETF ID, as of no later than `asOfDate` (docs/10 §4: G7's
 *  freshness gate is exactly "is the latest snapshot too old", so we always want the true latest,
 *  never an arbitrary as-of match). */
export async function loadLatestMetrics(
  supabase: SupabaseClient,
  etfIds: readonly number[],
  asOfDate: string
): Promise<Map<number, LatestMetricsRow>> {
  if (etfIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('etf_metrics')
    .select('etf_id, as_of, aum_cr, ter_pct, tracking_error_1y, tracking_diff_1y, tracking_diff_3y, adtv_paise, premium_discount_30d')
    .in('etf_id', etfIds)
    .lte('as_of', asOfDate)
    .order('as_of', { ascending: false });
  if (error) throw new Error(`failed to load etf_metrics: ${error.message}`);

  const latest = new Map<number, LatestMetricsRow>();
  for (const row of data as Array<{
    etf_id: number; as_of: string; aum_cr: number | null; ter_pct: number | null;
    tracking_error_1y: number | null; tracking_diff_1y: number | null; tracking_diff_3y: number | null;
    adtv_paise: string | null; premium_discount_30d: number | null;
  }>) {
    if (latest.has(row.etf_id)) continue; // rows are ordered as_of desc — first hit per etf is the latest
    latest.set(row.etf_id, {
      as_of: row.as_of, aum_cr: row.aum_cr, ter_pct: row.ter_pct,
      tracking_error_1y: row.tracking_error_1y, tracking_diff_1y: row.tracking_diff_1y, tracking_diff_3y: row.tracking_diff_3y,
      adtv_paise: row.adtv_paise ? BigInt(row.adtv_paise) : null,
      premium_discount_30d: row.premium_discount_30d,
    });
  }
  return latest;
}

/** Same-day close_paise / nav_paise for the plan-day premium check in gate G6 (docs/03 §3.1: "AND
 *  plan-day premium <= 1.0%"). */
export async function loadPlanDayPremiumPct(
  supabase: SupabaseClient,
  etfIds: readonly number[],
  runDate: string
): Promise<Map<number, number | null>> {
  if (etfIds.length === 0) return new Map();
  const [{ data: prices, error: priceErr }, { data: navs, error: navErr }] = await Promise.all([
    supabase.from('etf_prices').select('etf_id, close_paise').in('etf_id', etfIds).eq('d', runDate),
    supabase.from('etf_navs').select('etf_id, nav_paise').in('etf_id', etfIds).eq('d', runDate),
  ]);
  if (priceErr) throw new Error(`failed to load plan-day etf_prices: ${priceErr.message}`);
  if (navErr) throw new Error(`failed to load plan-day etf_navs: ${navErr.message}`);

  const priceByEtf = new Map((prices as Array<{ etf_id: number; close_paise: string }>).map((r) => [r.etf_id, BigInt(r.close_paise)]));
  const navByEtf = new Map((navs as Array<{ etf_id: number; nav_paise: string }>).map((r) => [r.etf_id, BigInt(r.nav_paise)]));

  const result = new Map<number, number | null>();
  for (const etfId of etfIds) {
    const price = priceByEtf.get(etfId);
    const nav = navByEtf.get(etfId);
    result.set(etfId, price !== undefined && nav !== undefined && nav > 0n
      ? (Number(price - nav) / Number(nav)) * 100
      : null);
  }
  return result;
}
