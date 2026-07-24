/**
 * refresh-metrics (docs/02 §4, docs/10 §2: cron fires every Saturday 10:00 IST; this function
 * no-ops unless today is the LAST Saturday of the month).
 *
 * AUM/TER/tracking-error/tracking-diff have no clean API (docs/02 §4) — those stay manual,
 * queued in metrics_review_queue for the owner. ADTV and premium/discount ARE fully computable
 * from already-ingested etf_prices/etf_navs (docs/05 comment), so this function computes exactly
 * those two fields. NOTE: a plain upsert of {source:'computed', ...} would still overwrite
 * `source`/`resolved` on every re-run even though those columns aren't the "changed" data —
 * PostgREST's ON CONFLICT DO UPDATE sets every column PRESENT in the payload, and those two are
 * present in every row we'd send. So this function instead checks which (etf_id, as_of) rows
 * already exist and only INSERTs missing ones (full row, source='computed'); an existing row —
 * whether from an earlier run today or an owner's manual submission via admin-submit-metrics —
 * gets an UPDATE of ONLY adtv_paise/premium_discount_30d, never touching source/resolved/the
 * manual-only fields. This also protects docs/10 §5's backup selection
 * (`etf_metrics where source='manual'`), which a silent overwrite would have broken.
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { runLoggedJob } from '../_shared/job-log.ts';
import { errorResponse } from '../_shared/http-error.ts';
import {
  lastSaturdayOfMonth, computeAdtv, computePremiumDiscount30d,
  type PriceObs, type NavObs,
} from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const MANUAL_ONLY_FIELDS = [
  'aum_cr', 'ter_pct', 'tracking_error_1y', 'tracking_diff_1y', 'tracking_diff_3y', 'tracking_diff_5y',
] as const;

function todayIstIso(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function loadActiveEtfIds(supabase: SupabaseClient): Promise<number[]> {
  const { data, error } = await supabase.from('etfs').select('id').eq('active', true);
  if (error) throw new Error(`failed to load active etfs: ${error.message}`);
  return (data as Array<{ id: number }>).map((r) => r.id);
}

async function loadExistingEtfIds(
  supabase: SupabaseClient,
  table: string,
  etfIds: number[],
  asOf: string
): Promise<Set<number>> {
  if (etfIds.length === 0) return new Set();
  const { data, error } = await supabase.from(table).select('etf_id').in('etf_id', etfIds).eq('as_of', asOf);
  if (error) throw new Error(`failed to check existing ${table} rows: ${error.message}`);
  return new Set((data as Array<{ etf_id: number }>).map((r) => r.etf_id));
}

async function loadWindow(
  supabase: SupabaseClient,
  etfIds: number[],
  asOf: string
): Promise<{ pricesByEtf: Map<number, PriceObs[]>; navsByEtf: Map<number, NavObs[]> }> {
  if (etfIds.length === 0) return { pricesByEtf: new Map(), navsByEtf: new Map() };
  // 40 calendar days comfortably covers >=30 trading days even across a holiday cluster.
  const windowStart = new Date(new Date(`${asOf}T00:00:00.000Z`).getTime() - 40 * 86400_000)
    .toISOString().slice(0, 10);

  const [pricesRes, navsRes] = await Promise.all([
    supabase.from('etf_prices').select('etf_id, d, close_paise, volume')
      .in('etf_id', etfIds).gte('d', windowStart).lte('d', asOf),
    supabase.from('etf_navs').select('etf_id, d, nav_paise')
      .in('etf_id', etfIds).gte('d', windowStart).lte('d', asOf),
  ]);
  if (pricesRes.error) throw new Error(`failed to load etf_prices window: ${pricesRes.error.message}`);
  if (navsRes.error) throw new Error(`failed to load etf_navs window: ${navsRes.error.message}`);

  const pricesByEtf = new Map<number, PriceObs[]>();
  for (const row of pricesRes.data as Array<{ etf_id: number; d: string; close_paise: string; volume: number | null }>) {
    const arr = pricesByEtf.get(row.etf_id) ?? [];
    arr.push({ d: row.d, closePaise: BigInt(row.close_paise), volume: row.volume });
    pricesByEtf.set(row.etf_id, arr);
  }
  const navsByEtf = new Map<number, NavObs[]>();
  for (const row of navsRes.data as Array<{ etf_id: number; d: string; nav_paise: string }>) {
    const arr = navsByEtf.get(row.etf_id) ?? [];
    arr.push({ d: row.d, navPaise: BigInt(row.nav_paise) });
    navsByEtf.set(row.etf_id, arr);
  }
  return { pricesByEtf, navsByEtf };
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();
    const today = todayIstIso();
    const yyyyMM = today.slice(0, 7);

    if (today !== lastSaturdayOfMonth(yyyyMM)) {
      return new Response(JSON.stringify({ ok: true, rows: 0, note: 'no-op: not the last Saturday of the month' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const outcome = await runLoggedJob(supabase, 'refresh-metrics', async () => {
      const etfIds = await loadActiveEtfIds(supabase);
      const { pricesByEtf, navsByEtf } = await loadWindow(supabase, etfIds, today);
      const existingMetrics = await loadExistingEtfIds(supabase, 'etf_metrics', etfIds, today);
      const existingQueue = await loadExistingEtfIds(supabase, 'metrics_review_queue', etfIds, today);

      const newMetricsRows: Array<{ etf_id: number; as_of: string; adtv_paise: string | null; premium_discount_30d: number | null; source: string }> = [];
      const updates: Array<{ etf_id: number; adtv_paise: string | null; premium_discount_30d: number | null }> = [];
      const newQueueRows: Array<{ etf_id: number; as_of: string; missing_fields: string[]; resolved: boolean }> = [];

      for (const etfId of etfIds) {
        const prices = pricesByEtf.get(etfId) ?? [];
        const navs = navsByEtf.get(etfId) ?? [];

        const adtv = computeAdtv(prices, today);
        const premDisc = computePremiumDiscount30d(prices, navs, today);
        const adtvPaise = adtv.adtvPaise?.toString() ?? null;
        const premiumDiscount = premDisc.avgPct;

        if (existingMetrics.has(etfId)) {
          updates.push({ etf_id: etfId, adtv_paise: adtvPaise, premium_discount_30d: premiumDiscount });
        } else {
          newMetricsRows.push({ etf_id: etfId, as_of: today, adtv_paise: adtvPaise, premium_discount_30d: premiumDiscount, source: 'computed' });
        }

        if (!existingQueue.has(etfId)) {
          newQueueRows.push({ etf_id: etfId, as_of: today, missing_fields: [...MANUAL_ONLY_FIELDS], resolved: false });
        }
      }

      if (newMetricsRows.length > 0) {
        const { error } = await supabase.from('etf_metrics').insert(newMetricsRows);
        if (error) throw new Error(`failed to insert etf_metrics: ${error.message}`);
      }
      // Existing rows (from an earlier retry today, or an owner's manual submission) get ONLY
      // the two computed fields updated — source/resolved/manual fields are never touched.
      for (const u of updates) {
        const { error } = await supabase.from('etf_metrics')
          .update({ adtv_paise: u.adtv_paise, premium_discount_30d: u.premium_discount_30d })
          .eq('etf_id', u.etf_id).eq('as_of', today);
        if (error) throw new Error(`failed to update etf_metrics for etf_id=${u.etf_id}: ${error.message}`);
      }
      if (newQueueRows.length > 0) {
        const { error } = await supabase.from('metrics_review_queue').insert(newQueueRows);
        if (error) throw new Error(`failed to insert metrics_review_queue: ${error.message}`);
      }

      return { rows: newMetricsRows.length + updates.length };
    });

    return new Response(JSON.stringify(outcome), {
      status: outcome.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
