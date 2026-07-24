/**
 * Writes a row failing a sanity gate to ingest_quarantine instead of upserting it (docs/09 §5).
 * Deliberately swallows its own write failures (logged, never thrown): this is a best-effort
 * audit side-channel called mid-batch, one row at a time — if a transient DB error here were
 * allowed to propagate, it would abort the whole ingestion function and discard every OTHER
 * already-fetched, valid row still waiting to be upserted in the same run. Losing one
 * diagnostic quarantine record is a far smaller cost than losing a night's prices for every ETF.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export async function writeQuarantine(
  supabase: SupabaseClient,
  job: string,
  naturalKey: string,
  raw: unknown,
  reason: string
): Promise<void> {
  const { error } = await supabase
    .from('ingest_quarantine')
    .insert({ job, natural_key: naturalKey, raw, reason });
  if (error) {
    console.error(`failed to write ingest_quarantine row (${naturalKey}, job=${job}): ${error.message}`);
  }
}
