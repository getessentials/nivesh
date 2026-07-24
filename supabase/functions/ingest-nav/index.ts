/**
 * ingest-nav (docs/02 §2, docs/10 §2: nightly 22:30 IST, daily incl. weekends — AMFI publishes
 * something even after a Friday close and idempotent upsert makes an extra no-op run harmless).
 * Primary: AMFI's bulk NAVAll.txt (one request covers every scheme — verified 2026-07-23 to
 * 302-redirect to portal.amfiindia.com; plain `fetch` follows redirects automatically).
 * Fallback (per scheme, only if AMFI's bulk file is missing that code): mfapi.in single-scheme
 * lookup (docs/02 §2 "use for daily upsert + integrity check of mfapi" — AMFI bulk is primary
 * for efficiency; mfapi covers the rare gap).
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { runLoggedJob } from '../_shared/job-log.ts';
import { writeQuarantine } from '../_shared/quarantine.ts';
import { fetchWithRetry } from '../_shared/http.ts';
import { errorResponse } from '../_shared/http-error.ts';
import {
  parseAmfiNavAll, parseFlexibleDate, checkTimeSeriesRow, rupeesToPaise,
  EtfNavRowSchema, type PreviousObservation,
} from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function todayIstIso(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

interface EtfRef { id: number; amfi_scheme_code: string | null }

async function loadEtfsWithSchemeCode(supabase: SupabaseClient): Promise<EtfRef[]> {
  const { data, error } = await supabase
    .from('etfs')
    .select('id, amfi_scheme_code')
    .eq('active', true)
    .not('amfi_scheme_code', 'is', null);
  if (error) throw new Error(`failed to load etfs: ${error.message}`);
  return data as EtfRef[];
}

// 45-day lookback (not shorter): a narrower window resolves `previous` to undefined across
// any longer gap, silently disabling the day-over-day jump gate exactly when it matters most.
async function loadLatestNavs(
  supabase: SupabaseClient,
  etfIds: number[],
  asOf: string
): Promise<Map<number, PreviousObservation>> {
  if (etfIds.length === 0) return new Map();
  const lookbackStart = new Date(new Date(`${asOf}T00:00:00.000Z`).getTime() - 45 * 86400_000)
    .toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('etf_navs')
    .select('etf_id, d, nav_paise')
    .in('etf_id', etfIds)
    .gte('d', lookbackStart)
    .order('d', { ascending: true });
  if (error) throw new Error(`failed to load recent etf_navs: ${error.message}`);

  const latest = new Map<number, PreviousObservation>();
  for (const row of data as Array<{ etf_id: number; d: string; nav_paise: string }>) {
    latest.set(row.etf_id, { date: row.d, value: Number(row.nav_paise) });
  }
  return latest;
}

interface MfapiResponse { data?: Array<{ date: string; nav: string }> }

async function fetchMfapiLatestNav(schemeCode: string): Promise<{ date: string; nav: number } | null> {
  const res = await fetchWithRetry(`https://api.mfapi.in/mf/${schemeCode}`);
  if (!res.ok) return null;
  const body = (await res.json()) as MfapiResponse;
  const latest = body.data?.[0]; // mfapi.in returns history newest-first
  if (!latest) return null;
  const nav = Number(latest.nav);
  if (!Number.isFinite(nav)) return null;
  return { date: parseFlexibleDate(latest.date), nav };
}

/** Validates a constructed row before it's allowed into an upsert batch (docs/09 §5) — never
 *  throws; a shape mismatch is quarantined like any other gate failure. */
async function validateOrQuarantine(
  supabase: SupabaseClient,
  naturalKey: string,
  candidate: unknown
): Promise<{ etf_id: number; d: string; nav_paise: string } | null> {
  const result = EtfNavRowSchema.safeParse(candidate);
  if (!result.success) {
    await writeQuarantine(supabase, 'ingest-nav', naturalKey, candidate, `schema_validation_failed: ${result.error.message}`);
    return null;
  }
  return result.data;
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();
    const today = todayIstIso();

    const outcome = await runLoggedJob(supabase, 'ingest-nav', async () => {
      const etfs = await loadEtfsWithSchemeCode(supabase);
      const latestByEtf = await loadLatestNavs(supabase, etfs.map((e) => e.id), today);

      const res = await fetchWithRetry(
        'https://www.amfiindia.com/spages/NAVAll.txt' // 302 -> portal.amfiindia.com; fetch follows it
      );
      if (!res.ok) throw new Error(`AMFI NAVAll.txt unavailable: HTTP ${res.status}`);
      const { rows } = parseAmfiNavAll(await res.text());

      const byScheme = new Map<string, { nav: number; date: string }>();
      for (const r of rows) byScheme.set(r.schemeCode, { nav: r.nav, date: r.date }); // last wins on dup

      const upsertRows: Array<{ etf_id: number; d: string; nav_paise: string }> = [];
      let quarantined = 0;

      for (const etf of etfs) {
        let obs = byScheme.get(etf.amfi_scheme_code!);
        if (!obs) {
          const mfapiObs = await fetchMfapiLatestNav(etf.amfi_scheme_code!).catch(() => null);
          if (!mfapiObs) {
            await writeQuarantine(supabase, 'ingest-nav', `etf_id=${etf.id},d=${today}`,
              { schemeCode: etf.amfi_scheme_code }, 'not_found_in_amfi_and_mfapi_failed');
            quarantined++;
            continue;
          }
          obs = { nav: mfapiObs.nav, date: mfapiObs.date };
        }

        const previous = latestByEtf.get(etf.id);
        const gate = checkTimeSeriesRow({ value: obs.nav, date: obs.date, today, previous });
        if (!gate.ok) {
          await writeQuarantine(supabase, 'ingest-nav', `etf_id=${etf.id},d=${obs.date}`, obs, gate.reason!);
          quarantined++;
          continue;
        }

        const navPaise = rupeesToPaise(obs.nav);
        const validated = await validateOrQuarantine(supabase, `etf_id=${etf.id},d=${obs.date}`, {
          etf_id: etf.id, d: obs.date, nav_paise: navPaise.toString(),
        });
        if (!validated) { quarantined++; continue; }
        upsertRows.push(validated);
        latestByEtf.set(etf.id, { date: obs.date, value: Number(navPaise) });
      }

      if (upsertRows.length > 0) {
        const { error } = await supabase.from('etf_navs').upsert(upsertRows, { onConflict: 'etf_id,d' });
        if (error) throw new Error(`failed to upsert etf_navs: ${error.message}`);
      }

      return { rows: upsertRows.length, quarantined };
    });

    return new Response(JSON.stringify(outcome), {
      status: outcome.ok ? 200 : 500,
      headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
