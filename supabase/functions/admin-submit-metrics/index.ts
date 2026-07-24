/**
 * admin-submit-metrics (docs/09 §2.1 owner-admin functions, docs/02 §4): the manual-entry path
 * for the etf_metrics fields no free API provides (AUM, TER, tracking error/diff) — refresh-metrics
 * queues an (etf_id, as_of) row per active ETF in metrics_review_queue every "manual-only" cycle;
 * this function is how the owner clears that queue. Admin-JWT only (never cron-invocable — this
 * is always a deliberate manual action, docs/09 §2.1's owner-admin row).
 *
 * All-or-nothing (docs/09 §6's CSV-import spirit extended to this submission form): every row in
 * the batch is schema/sanity-validated before ANY write happens, so a single typo'd row never
 * partially applies alongside good ones.
 *
 * Writes UPDATE, never INSERT, onto etf_metrics — refresh-metrics always creates the row (with the
 * computed adtv_paise/premium_discount_30d fields) at the same time it queues the review entry, so
 * by construction a resolvable queue row implies an existing etf_metrics row (see refresh-metrics'
 * own header comment). A submission naming an (etf_id, as_of) with no matching UNRESOLVED queue
 * row is rejected — that guards against a stale/duplicate submission silently overwriting a
 * different (and possibly already-correct) as_of snapshot.
 */
import { verifyAdminJwt } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { EtfMetricsManualSchema, type EtfMetricsManual } from '@niveshetf/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function loadUnresolvedQueueKeys(
  supabase: SupabaseClient,
  submissions: readonly EtfMetricsManual[]
): Promise<Set<string>> {
  if (submissions.length === 0) return new Set();
  const etfIds = [...new Set(submissions.map((s) => s.etf_id))];
  const { data, error } = await supabase
    .from('metrics_review_queue')
    .select('etf_id, as_of')
    .in('etf_id', etfIds)
    .eq('resolved', false);
  if (error) throw new Error(`failed to load metrics_review_queue: ${error.message}`);
  return new Set((data as Array<{ etf_id: number; as_of: string }>).map((r) => `${r.etf_id}|${r.as_of}`));
}

Deno.serve(async (req) => {
  try {
    await verifyAdminJwt(req);
    const supabase = createServiceClient();

    const payload = await req.json().catch(() => ({}));
    const rawSubmissions = Array.isArray(payload.submissions) ? payload.submissions : null;
    if (!rawSubmissions || rawSubmissions.length === 0) {
      throw new HttpError(400, 'body must be { submissions: [...] } with at least one row');
    }
    if (rawSubmissions.length > 200) {
      throw new HttpError(400, 'too many rows in one submission (max 200)');
    }

    const submissions: EtfMetricsManual[] = [];
    for (let i = 0; i < rawSubmissions.length; i++) {
      const parsed = EtfMetricsManualSchema.safeParse(rawSubmissions[i]);
      if (!parsed.success) {
        throw new HttpError(400, `row ${i}: ${parsed.error.issues.map((iss) => `${iss.path.join('.')} ${iss.message}`).join('; ')}`);
      }
      submissions.push(parsed.data);
    }

    const unresolvedKeys = await loadUnresolvedQueueKeys(supabase, submissions);
    const unknownRows = submissions.filter((s) => !unresolvedKeys.has(`${s.etf_id}|${s.as_of}`));
    if (unknownRows.length > 0) {
      throw new HttpError(
        400,
        `no unresolved metrics_review_queue entry for: ${unknownRows.map((s) => `etf_id=${s.etf_id},as_of=${s.as_of}`).join(', ')}`
      );
    }

    // All rows validated and confirmed resolvable — now write. Each row is an independent
    // (etf_id, as_of) primary key, so a per-row failure here would indicate a real DB problem,
    // not a data problem (already caught above) — let it throw and fail the whole request rather
    // than silently partially applying.
    for (const s of submissions) {
      const { error: updErr } = await supabase
        .from('etf_metrics')
        .update({
          aum_cr: s.aum_cr,
          ter_pct: s.ter_pct,
          tracking_error_1y: s.tracking_error_1y,
          tracking_diff_1y: s.tracking_diff_1y,
          tracking_diff_3y: s.tracking_diff_3y ?? null,
          tracking_diff_5y: s.tracking_diff_5y ?? null,
          source: 'manual',
        })
        .eq('etf_id', s.etf_id).eq('as_of', s.as_of);
      if (updErr) throw new Error(`failed to update etf_metrics for etf_id=${s.etf_id},as_of=${s.as_of}: ${updErr.message}`);

      const { error: queueErr } = await supabase
        .from('metrics_review_queue')
        .update({ resolved: true })
        .eq('etf_id', s.etf_id).eq('as_of', s.as_of);
      if (queueErr) throw new Error(`failed to resolve metrics_review_queue for etf_id=${s.etf_id},as_of=${s.as_of}: ${queueErr.message}`);
    }

    return jsonResponse({ ok: true, resolved: submissions.length });
  } catch (err) {
    return errorResponse(err);
  }
});
