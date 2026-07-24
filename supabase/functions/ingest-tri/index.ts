/**
 * ingest-tri (docs/02 §3, docs/10 §2: nightly 23:00 IST, daily).
 * The ORIGINAL contract coded here (`Backpage.aspx/getTotalReturnIndexString`, JSON-with-ISO-dates
 * payload, `{d: "<csv>"}` response envelope) was simply wrong — not a niftyindices outage. Fixed
 * 2026-07-24 against the real contract captured from a live browser network call (see
 * `tryFetchNiftyindicesTri`'s own comment for the exact shape). Confirmed working via direct curl
 * from a non-Supabase IP — but **Supabase Edge Functions' egress IPs are still blocked** (the same
 * datacenter-IP filtering pattern documented for Yahoo in ingest-prices), so this still fails in
 * production despite being contractually correct. The manual CSV upload path (Settings, an
 * owner-admin function) remains the expected first-class path per docs/02 §3 until that changes.
 *
 * Design consequence (docs/10 §2, fixed in Phase 0 loop 2 for exactly this reason): the
 * monthly-run precondition checks index_tri DATA PRESENCE, never this job's `ok` flag — so
 * this function is allowed to honestly report ok=false when niftyindices is unreachable and some
 * indices remain uncovered. It still attempts the fetch every night (in case the IP block lifts),
 * and always reports exactly which indices are covered vs still missing, so the dashboard banner
 * (docs/10 §6) can prompt the owner toward a manual upload.
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
import { checkTimeSeriesRow, IndexTriRowSchema, isoDateToDDMonYYYY, parseFlexibleDate, type PreviousObservation } from '../_shared/shared-lib.ts';
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
 * Best-effort niftyindices fetch for one index. Confirmed working contract (2026-07-24, captured
 * from the live browser network tab against `/reports/historical-data` — the previously-coded
 * `Backpage.aspx/...` path and JSON-with-ISO-dates payload were both wrong, which is why every
 * automated attempt failed since Phase 0):
 *   - URL: `BackPage/getTotalReturnIndexString` (capital B/P, no `.aspx`)
 *   - Body: `{"cinfo": "<single-quoted pseudo-JSON, NOT real JSON>"}`, e.g.
 *     `{'name':'NIFTY 50','startDate':'24-Jul-2025','endDate':'24-Jul-2026','indexName':'NIFTY 50'}`
 *     — dates as `DD-Mon-YYYY`, not ISO.
 *   - Response: a plain JSON array of `{Date, "Index Name", NTR_Value, TotalReturnsIndex,
 *     RequestNumber}` objects (Date as `DD Mon YYYY`, space-separated) — NOT the `{d: "<csv>"}`
 *     ASP.NET-page-method envelope the old code expected, and not CSV text at all.
 * Returns null on any failure rather than throwing — a single index's failure must not abort the
 * other indices' attempts.
 */
async function tryFetchNiftyindicesTri(
  indexName: string,
  fromDate: string,
  toDate: string
): Promise<{ date: string; value: number }[] | null> {
  try {
    const cinfo = `{'name':'${indexName}','startDate':'${isoDateToDDMonYYYY(fromDate)}','endDate':'${isoDateToDDMonYYYY(toDate)}','indexName':'${indexName}'}`;
    const res = await fetchWithRetry('https://www.niftyindices.com/BackPage/getTotalReturnIndexString', {
      maxAttempts: 2,
      method: 'POST',
      body: JSON.stringify({ cinfo }),
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'Referer': 'https://www.niftyindices.com/reports/historical-data',
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return null;
    const rows: { date: string; value: number }[] = [];
    for (const row of body as Array<Record<string, unknown>>) {
      const rawDate = row['Date'];
      const rawValue = row['TotalReturnsIndex'];
      if (typeof rawDate !== 'string' || (typeof rawValue !== 'string' && typeof rawValue !== 'number')) continue;
      const value = Number(rawValue);
      if (!Number.isFinite(value)) continue;
      rows.push({ date: parseFlexibleDate(rawDate), value });
    }
    return rows;
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
        // The API returns rows newest-first; sort ascending so "last" reliably means "most
        // recent" regardless of the response's own ordering.
        const sorted = fetched ? [...fetched].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) : undefined;
        const latestBar = sorted?.at(-1);
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
