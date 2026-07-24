/**
 * admin-upload-tri (docs/09 §2.1 owner-admin functions, docs/02 §3): manual TRI CSV upload —
 * the first-class path since niftyindices' POST endpoints were observed erroring as of
 * 2026-07-23 (ingest-tri's own header comment). One file = one index's history
 * (packages/shared/src/parsers/tri-csv.ts, shared with the automated ingest-tri attempt).
 * Admin-JWT only (never cron-invocable — always a deliberate manual action).
 *
 * All-or-nothing (docs/09 §6): every row is schema- AND sanity-gate-validated (docs/09 §5: the
 * SAME checkTimeSeriesRow used by every automated ingester) before any write happens — one bad
 * row (typo'd value, a >20% day-over-day jump, a future date) rejects the whole file rather than
 * silently partially ingesting a chart with a gap or a spike in it.
 */
import { verifyAdminJwt } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { handlePreflight, withCors } from '../_shared/cors.ts';
import {
  parseTriCsv, checkTimeSeriesRow, IndexTriRowSchema, type PreviousObservation,
} from '@niveshetf/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const MAX_CSV_BYTES = 1_000_000; // docs/09 §6
const MAX_ROWS = 5_000; // docs/09 §6

async function assertKnownTriIndex(supabase: SupabaseClient, indexName: string): Promise<void> {
  const { data, error } = await supabase.from('indices').select('name').eq('name', indexName).eq('tri_source', 'niftyindices').maybeSingle();
  if (error) throw new Error(`failed to look up index "${indexName}": ${error.message}`);
  if (!data) throw new HttpError(400, `"${indexName}" is not a known niftyindices-sourced TRI index`);
}

async function loadPriorObservation(supabase: SupabaseClient, indexName: string, beforeDate: string): Promise<PreviousObservation | undefined> {
  const { data, error } = await supabase
    .from('index_tri')
    .select('d, value')
    .eq('index_name', indexName)
    .lt('d', beforeDate)
    .order('d', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`failed to load prior index_tri observation for "${indexName}": ${error.message}`);
  return data ? { date: (data as { d: string }).d, value: (data as { value: number }).value } : undefined;
}

Deno.serve(async (req) => {
  const preflight = handlePreflight(req);
  if (preflight) return preflight;

  try {
    await verifyAdminJwt(req);
    const supabase = createServiceClient();

    const payload = await req.json().catch(() => ({}));
    const indexName = typeof payload.indexName === 'string' ? payload.indexName : null;
    const csvText = typeof payload.csvText === 'string' ? payload.csvText : null;
    if (!indexName || !csvText) throw new HttpError(400, 'body must be { indexName, csvText }');

    const byteLength = new TextEncoder().encode(csvText).length;
    if (byteLength > MAX_CSV_BYTES) throw new HttpError(400, `CSV too large: ${byteLength} bytes (max ${MAX_CSV_BYTES})`);
    if (csvText.includes('�')) throw new HttpError(400, 'CSV contains invalid UTF-8 (replacement characters found)');

    await assertKnownTriIndex(supabase, indexName);

    let parsed: Array<{ date: string; value: number }>;
    try {
      parsed = parseTriCsv(csvText);
    } catch (err) {
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    if (parsed.length === 0) throw new HttpError(400, 'CSV has no parseable data rows');
    if (parsed.length > MAX_ROWS) throw new HttpError(400, `too many rows: ${parsed.length} (max ${MAX_ROWS})`);

    const sorted = [...parsed].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const todayIso = new Date().toISOString().slice(0, 10);
    let previous = await loadPriorObservation(supabase, indexName, sorted[0]!.date);

    const failures: string[] = [];
    const validatedRows: Array<{ index_name: string; d: string; value: number }> = [];
    for (const row of sorted) {
      const gate = checkTimeSeriesRow({ value: row.value, date: row.date, today: todayIso, previous });
      if (!gate.ok) {
        failures.push(`${row.date}: ${gate.reason}`);
        continue;
      }
      const parsedRow = IndexTriRowSchema.safeParse({ index_name: indexName, d: row.date, value: row.value });
      if (!parsedRow.success) {
        failures.push(`${row.date}: schema_validation_failed`);
        continue;
      }
      validatedRows.push(parsedRow.data);
      previous = { date: row.date, value: row.value }; // only a row that PASSED becomes the new baseline
    }

    if (failures.length > 0) {
      throw new HttpError(400, `rejected — ${failures.length} row(s) failed validation (all-or-nothing, nothing written): ${failures.slice(0, 20).join('; ')}${failures.length > 20 ? '; …' : ''}`);
    }

    const { error: upsertErr } = await supabase.from('index_tri').upsert(validatedRows, { onConflict: 'index_name,d' });
    if (upsertErr) throw new Error(`failed to upsert index_tri: ${upsertErr.message}`);

    return withCors(jsonResponse({
      ok: true,
      indexName,
      rowsWritten: validatedRows.length,
      dateRange: { from: sorted[0]!.date, to: sorted[sorted.length - 1]!.date },
    }));
  } catch (err) {
    return withCors(errorResponse(err));
  }
});
