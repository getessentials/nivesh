/**
 * ingest-tri (docs/02 §3, docs/10 §2: nightly 23:00 IST, daily).
 * niftyindices' POST endpoints were verified ERRORING as of 2026-07-23 (Phase 0, re-confirmed
 * at build step 2 — `Backpage.aspx/getTotalReturnIndexString` returns a generic processing
 * error regardless of payload shape). The manual CSV upload path (Settings, an owner-admin
 * function) is the expected first-class path per docs/02 §3, not this ingester.
 *
 * Design consequence (docs/10 §2, fixed in Phase 0 loop 2 for exactly this reason): the
 * monthly-run precondition checks index_tri DATA PRESENCE, never this job's `ok` flag — so
 * this function is allowed to honestly report ok=false when niftyindices is down and some
 * indices remain uncovered. It still attempts the fetch every night (in case NSE fixes the
 * endpoint) and always reports exactly which indices are covered vs still missing, so the
 * dashboard banner (docs/10 §6) can prompt the owner toward a manual upload.
 *
 * nav_proxy indices (gold/silver/ai_global_tech/debt_liquid, docs/03 §6) need no index_tri row
 * at all — the engine reads etf_navs of the pinned proxy ETF directly (docs/05 comment).
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { runLoggedJob } from '../_shared/job-log.ts';
import { fetchWithRetry } from '../_shared/http.ts';
import { errorResponse } from '../_shared/http-error.ts';
import { parseTriCsv, checkTimeSeriesRow, IndexTriRowSchema, type PreviousObservation } from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function todayIstIso(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function loadTriBenchmarkIndices(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('indices')
    .select('name')
    .eq('tri_source', 'niftyindices');
  if (error) throw new Error(`failed to load TRI benchmark indices: ${error.message}`);
  return (data as Array<{ name: string }>).map((r) => r.name);
}

async function indicesMissingToday(
  supabase: SupabaseClient,
  indexNames: string[],
  today: string
): Promise<string[]> {
  const { data, error } = await supabase
    .from('index_tri')
    .select('index_name')
    .in('index_name', indexNames)
    .eq('d', today);
  if (error) throw new Error(`failed to check existing index_tri rows: ${error.message}`);
  const present = new Set((data as Array<{ index_name: string }>).map((r) => r.index_name));
  return indexNames.filter((n) => !present.has(n));
}

/**
 * Best-effort niftyindices fetch for one index. VERIFY-AT-SEED: the exact working payload
 * contract (last confirmed working shape unknown; both a raw-JSON and a `cinfo`-wrapped POST
 * to `Backpage.aspx/getTotalReturnIndexString` returned a generic processing error as of
 * 2026-07-23). Returns null on any failure rather than throwing — a single index's failure
 * must not abort the other indices' attempts.
 */
async function tryFetchNiftyindicesTri(
  indexName: string,
  fromDate: string,
  toDate: string
): Promise<{ date: string; value: number }[] | null> {
  try {
    const cinfo = JSON.stringify({ name: indexName, startDate: fromDate, endDate: toDate, indexName });
    const res = await fetchWithRetry('https://www.niftyindices.com/Backpage.aspx/getTotalReturnIndexString', {
      maxAttempts: 2,
      method: 'POST',
      body: JSON.stringify({ cinfo }),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Referer': 'https://www.niftyindices.com/reports/historical-data',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { d?: string };
    if (!body.d) return null;
    return parseTriCsv(body.d);
  } catch {
    return null;
  }
}

// 45-day lookback (not shorter): a narrower window resolves `previous` to undefined across
// any longer gap, silently disabling the day-over-day jump gate exactly when it matters most.
async function loadLatestTri(
  supabase: SupabaseClient,
  indexNames: string[],
  asOf: string
): Promise<Map<string, PreviousObservation>> {
  const lookbackStart = new Date(new Date(`${asOf}T00:00:00.000Z`).getTime() - 45 * 86400_000)
    .toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('index_tri')
    .select('index_name, d, value')
    .in('index_name', indexNames)
    .gte('d', lookbackStart)
    .order('d', { ascending: true });
  if (error) throw new Error(`failed to load recent index_tri: ${error.message}`);
  const latest = new Map<string, PreviousObservation>();
  for (const row of data as Array<{ index_name: string; d: string; value: number }>) {
    latest.set(row.index_name, { date: row.d, value: row.value });
  }
  return latest;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();
    const today = todayIstIso();
    const fiveDaysAgo = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - 5 * 86400_000)
      .toISOString().slice(0, 10);

    const outcome = await runLoggedJob(supabase, 'ingest-tri', async () => {
      const allIndices = await loadTriBenchmarkIndices(supabase);
      const missing = await indicesMissingToday(supabase, allIndices, today);

      if (missing.length === 0) {
        return { rows: 0 }; // no-op success: every benchmark already has today's row
      }

      const latestByIndex = await loadLatestTri(supabase, missing, today);
      const upsertRows: Array<{ index_name: string; d: string; value: number }> = [];
      const stillMissing: string[] = [];

      for (const indexName of missing) {
        const fetched = await tryFetchNiftyindicesTri(indexName, fiveDaysAgo, today);
        const latestBar = fetched?.at(-1);
        if (!latestBar) { stillMissing.push(indexName); continue; }

        const previous = latestByIndex.get(indexName);
        const gate = checkTimeSeriesRow({ value: latestBar.value, date: latestBar.date, today, previous });
        if (!gate.ok) { stillMissing.push(`${indexName} (${gate.reason})`); continue; }

        const validated = IndexTriRowSchema.safeParse({ index_name: indexName, d: latestBar.date, value: latestBar.value });
        if (!validated.success) { stillMissing.push(`${indexName} (schema_validation_failed)`); continue; }
        upsertRows.push(validated.data);
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase.from('index_tri').upsert(upsertRows, { onConflict: 'index_name,d' });
        if (error) throw new Error(`failed to upsert index_tri: ${error.message}`);
      }

      if (stillMissing.length > 0) {
        // Honest partial failure — the manual CSV upload path (docs/02 §3) is expected to
        // close this gap before the monthly-run precondition deadline (docs/10 §2).
        throw new Error(
          `niftyindices unreachable for: ${stillMissing.join(', ')} — use the manual TRI CSV upload`
        );
      }

      return { rows: upsertRows.length };
    });

    return new Response(JSON.stringify(outcome), {
      status: outcome.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
