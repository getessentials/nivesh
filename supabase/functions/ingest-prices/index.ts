/**
 * ingest-prices (docs/02 §1, docs/10 §2: nightly 18:30 IST, Mon-Fri).
 * Primary: Yahoo chart API per `.NS` symbol. Fallback (per ETF, only on Yahoo failure): NSE's
 * UDiFF bhavcopy, ISIN-keyed (docs/07 ENG-3 — fully implemented, not a stub).
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { runLoggedJob } from '../_shared/job-log.ts';
import { writeQuarantine } from '../_shared/quarantine.ts';
import { fetchWithRetry } from '../_shared/http.ts';
import { errorResponse } from '../_shared/http-error.ts';
import { unzipSync } from 'fflate';
import {
  parseYahooChart, parseNseBhavcopy, checkTimeSeriesRow, rupeesToPaise, isTradingDay,
  EtfPriceRowSchema, type EtfPriceRow, type PreviousObservation,
} from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function todayIstIso(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

interface EtfRef { id: number; yahoo_symbol: string; isin: string }

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

async function loadActiveEtfs(supabase: SupabaseClient): Promise<EtfRef[]> {
  const { data, error } = await supabase
    .from('etfs')
    .select('id, yahoo_symbol, isin')
    .eq('active', true);
  if (error) throw new Error(`failed to load active etfs: ${error.message}`);
  return data as EtfRef[];
}

/**
 * Latest known etf_prices row per etf_id, from the last 45 days (batched, not N queries). 45,
 * not a shorter window: a shorter lookback would resolve `previous` to undefined across any
 * gap wider than the window, silently DISABLING the day-over-day jump gate exactly in the
 * longer-outage/backfill scenarios where it matters most (a gate that only fires when nothing
 * went wrong isn't much of a gate). Matches the same 45-day reasoning in packages/shared
 * metrics.ts.
 */
async function loadLatestPrices(
  supabase: SupabaseClient,
  etfIds: number[],
  asOf: string
): Promise<Map<number, PreviousObservation>> {
  if (etfIds.length === 0) return new Map();
  const lookbackStart = new Date(new Date(`${asOf}T00:00:00.000Z`).getTime() - 45 * 86400_000)
    .toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('etf_prices')
    .select('etf_id, d, close_paise')
    .in('etf_id', etfIds)
    .gte('d', lookbackStart)
    .order('d', { ascending: true });
  if (error) throw new Error(`failed to load recent etf_prices: ${error.message}`);

  const latest = new Map<number, PreviousObservation>();
  for (const row of data as Array<{ etf_id: number; d: string; close_paise: string }>) {
    latest.set(row.etf_id, { date: row.d, value: Number(row.close_paise) });
  }
  return latest;
}

// The real UDiFF CSV is ~0.5-1MB uncompressed (verified live, docs/02 §1); these caps are
// generous headroom, not a tuned estimate — upstream is untrusted input (docs/09 §5), and a
// DNS hijack / CDN compromise of nsearchives.nseindia.com serving an oversized zip must not be
// able to OOM the function. The compressed-size check is a fast early rejection (advisory —
// Content-Length can be absent or wrong); the REAL guard is the `filter` callback, which fflate
// evaluates against the zip's declared originalSize per entry BEFORE inflating anything
// (verified empirically: a 300MB-decompressed bomb is rejected in <1ms, 0 bytes allocated).
const MAX_ZIP_COMPRESSED_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB

async function fetchNseBhavcopy(asOf: string): Promise<Map<string, { close: number; volume: number; tradedValue: number; date: string }>> {
  const [y, m, d] = asOf.split('-');
  const ddmmyyyy = `${d}${m}${y}`;
  const url = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${ddmmyyyy}_F_0000.csv.zip`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`NSE bhavcopy unavailable for ${asOf}: HTTP ${res.status}`);

  const contentLength = res.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_ZIP_COMPRESSED_BYTES) {
    throw new Error(`NSE bhavcopy response implausibly large (Content-Length=${contentLength}), refusing to download`);
  }
  const zipBytes = new Uint8Array(await res.arrayBuffer());
  if (zipBytes.length > MAX_ZIP_COMPRESSED_BYTES) {
    throw new Error(`NSE bhavcopy response implausibly large (${zipBytes.length} bytes), refusing to unzip`);
  }

  const unzipped = unzipSync(zipBytes, {
    filter: (file) => file.originalSize <= MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES,
  });
  const csvFilename = Object.keys(unzipped).find((name) => name.toLowerCase().endsWith('.csv'));
  if (!csvFilename) throw new Error('NSE bhavcopy zip contained no .csv file within the size guard');
  const csvText = new TextDecoder().decode(unzipped[csvFilename]);
  const rows = parseNseBhavcopy(csvText);
  return new Map(rows.map((r) => [r.isin, { close: r.close, volume: r.volume, tradedValue: r.tradedValue, date: r.date }]));
}

/**
 * Validates a constructed row against the wire schema before it's allowed into an upsert batch
 * (docs/09 §5: ingested data is untrusted input) — never throws; a shape mismatch is quarantined
 * like any other gate failure, never allowed to abort processing of the rest of the batch.
 */
async function validateOrQuarantine(
  supabase: SupabaseClient,
  job: string,
  naturalKey: string,
  candidate: unknown
): Promise<EtfPriceRow | null> {
  const result = EtfPriceRowSchema.safeParse(candidate);
  if (!result.success) {
    await writeQuarantine(supabase, job, naturalKey, candidate, `schema_validation_failed: ${result.error.message}`);
    return null;
  }
  return result.data;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();
    const today = todayIstIso();

    // docs/10 §2 cron catalog promises a "skip-if-holiday check inside function" — a weekday
    // NSE holiday would otherwise waste every ETF's Yahoo call and risks Yahoo serving an odd
    // placeholder value that spuriously trips the jump gate.
    const holidays = await loadHolidays(supabase);
    if (!isTradingDay(today, holidays)) {
      return new Response(JSON.stringify({ ok: true, rows: 0, note: 'no-op: not a trading day' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const outcome = await runLoggedJob(supabase, 'ingest-prices', async () => {
      const etfs = await loadActiveEtfs(supabase);
      const latestByEtf = await loadLatestPrices(supabase, etfs.map((e) => e.id), today);

      const upsertRows: EtfPriceRow[] = [];
      const yahooFailed: EtfRef[] = [];
      let quarantined = 0;

      for (const etf of etfs) {
        // The ENTIRE per-ETF body is inside one try/catch, including arithmetic
        // (rupeesToPaise/BigInt) — a bad value from Yahoo (e.g. a non-integer volume, which
        // parseYahooChart does not itself validate) must quarantine that ETF, never abort
        // processing of every other ETF already queued in upsertRows this run.
        try {
          const res = await fetchWithRetry(
            `https://query1.finance.yahoo.com/v8/finance/chart/${etf.yahoo_symbol}?range=5d&interval=1d`
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const parsed = parseYahooChart(await res.json());
          // An empty bars array (vs. bars that just aren't NEW yet) signals a real problem with
          // this symbol/day — worth the bhavcopy fallback, not a silent no-op.
          if (parsed.bars.length === 0) throw new Error('Yahoo returned zero bars');

          // Self-heal small gaps for free: `range=5d` already fetches several days of history
          // for redundancy — process every bar newer than the last stored observation (not
          // just the latest), so a 1-2 day miss (e.g. yesterday's run failed) backfills
          // automatically instead of leaving a permanent gap in ingest_quarantine.
          const previous = latestByEtf.get(etf.id);
          const newBars = parsed.bars
            .filter((b) => !previous || b.date > previous.date)
            .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

          if (newBars.length === 0) { continue; } // already up to date; not a failure

          let runningPrevious = previous;
          for (const bar of newBars) {
            if (bar.volume == null) {
              await writeQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${bar.date}`, bar, 'missing_volume');
              quarantined++;
              continue;
            }
            const gate = checkTimeSeriesRow({ value: bar.close, date: bar.date, today, previous: runningPrevious });
            if (!gate.ok) {
              await writeQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${bar.date}`, bar, gate.reason!);
              quarantined++;
              continue;
            }
            const closePaise = rupeesToPaise(bar.close);
            const validated = await validateOrQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${bar.date}`, {
              etf_id: etf.id,
              d: bar.date,
              close_paise: closePaise.toString(),
              volume: bar.volume,
              traded_value_paise: (closePaise * BigInt(bar.volume)).toString(),
            });
            if (!validated) { quarantined++; continue; }
            upsertRows.push(validated);
            runningPrevious = { date: bar.date, value: Number(closePaise) };
            // Updated incrementally, not just once after the loop: if a LATER bar in this same
            // self-heal run throws (e.g. BigInt() on a bad volume), the earlier bars already
            // pushed to upsertRows are still correctly persisted — latestByEtf must reflect
            // that immediately, so if this ETF then falls through to the bhavcopy fallback
            // below, its jump-gate check compares against the freshest baseline, not a stale
            // pre-run one.
            latestByEtf.set(etf.id, runningPrevious);
          }
        } catch {
          yahooFailed.push(etf);
          continue;
        }
      }

      // Persist the Yahoo-successful rows NOW, before attempting the bhavcopy fallback below —
      // a fetch/parse problem in the fallback path must never risk losing already-fetched,
      // valid prices for every other ETF in this run.
      if (upsertRows.length > 0) {
        const { error } = await supabase.from('etf_prices').upsert(upsertRows, { onConflict: 'etf_id,d' });
        if (error) throw new Error(`failed to upsert etf_prices (Yahoo pass): ${error.message}`);
      }
      const yahooRowCount = upsertRows.length;
      const fallbackRows: typeof upsertRows = [];

      // NSE bhavcopy fallback — fetched once (not per-ETF), only if at least one ETF needs it.
      if (yahooFailed.length > 0) {
        let bhavcopy: Map<string, { close: number; volume: number; tradedValue: number; date: string }> | null = null;
        try {
          bhavcopy = await fetchNseBhavcopy(today);
        } catch (e) {
          // Bhavcopy itself unavailable (not yet published, or endpoint down) — every
          // Yahoo-failed ETF is quarantined below; tomorrow's run picks them up (idempotent).
          for (const etf of yahooFailed) {
            await writeQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${today}`,
              { reason: 'yahoo_failed_and_bhavcopy_unavailable' },
              e instanceof Error ? e.message : String(e));
            quarantined++;
          }
        }

        if (bhavcopy) {
          for (const etf of yahooFailed) {
            const row = bhavcopy.get(etf.isin);
            if (!row) {
              await writeQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${today}`,
                { reason: 'not_found_in_bhavcopy' }, 'source_unavailable');
              quarantined++;
              continue;
            }
            const previous = latestByEtf.get(etf.id);
            const gate = checkTimeSeriesRow({ value: row.close, date: row.date, today, previous });
            if (!gate.ok) {
              await writeQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${row.date}`, row, gate.reason!);
              quarantined++;
              continue;
            }
            const closePaise = rupeesToPaise(row.close);
            const validated = await validateOrQuarantine(supabase, 'ingest-prices', `etf_id=${etf.id},d=${row.date}`, {
              etf_id: etf.id,
              d: row.date,
              close_paise: closePaise.toString(),
              volume: row.volume,
              traded_value_paise: rupeesToPaise(row.tradedValue).toString(),
            });
            if (!validated) { quarantined++; continue; }
            fallbackRows.push(validated);
          }
        }
      }

      if (fallbackRows.length > 0) {
        const { error } = await supabase.from('etf_prices').upsert(fallbackRows, { onConflict: 'etf_id,d' });
        if (error) throw new Error(`failed to upsert etf_prices (bhavcopy fallback pass): ${error.message}`);
      }

      return { rows: yahooRowCount + fallbackRows.length, quarantined };
    });

    return new Response(JSON.stringify(outcome), {
      status: outcome.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
