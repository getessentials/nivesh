/**
 * job_runs bookkeeping (docs/10 §6 dashboard banner reads this table). Error strings are
 * truncated to 500 chars — matches the DB CHECK constraint added in build step 1 (docs/09 §5:
 * no raw upstream payload bodies belong here; job_runs is SELECT-open to all authenticated
 * users).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_ERROR_LEN = 500;

export async function startJob(supabase: SupabaseClient, job: string): Promise<number> {
  const { data, error } = await supabase.from('job_runs').insert({ job }).select('id').single();
  if (error) throw new Error(`failed to start job_runs row for "${job}": ${error.message}`);
  return data.id as number;
}

export interface JobOutcome {
  ok: boolean;
  rows?: number;
  error?: string;
  /** Diagnostic only — never persisted to job_runs (no such column); ingest_quarantine rows
   *  are the durable record. Surfaced in the HTTP response for at-a-glance observability. */
  quarantined?: number;
}

export async function finishJob(supabase: SupabaseClient, id: number, outcome: JobOutcome): Promise<void> {
  const truncatedError = outcome.error ? outcome.error.slice(0, MAX_ERROR_LEN) : null;
  const { error } = await supabase
    .from('job_runs')
    .update({
      finished_at: new Date().toISOString(),
      ok: outcome.ok,
      rows: outcome.rows ?? null,
      error: truncatedError,
    })
    .eq('id', id);
  if (error) throw new Error(`failed to finish job_runs row ${id}: ${error.message}`);
}

/** Runs `fn`, always logging start/finish to job_runs, and never throwing past this wrapper —
 *  a caught error is recorded as a failed job, matching "no silent ingester failures" (docs/10 §6). */
export async function runLoggedJob(
  supabase: SupabaseClient,
  job: string,
  fn: () => Promise<{ rows: number; quarantined?: number }>
): Promise<JobOutcome> {
  const id = await startJob(supabase, job);
  try {
    const { rows, quarantined } = await fn();
    const outcome: JobOutcome = { ok: true, rows, quarantined };
    await finishJob(supabase, id, outcome);
    return outcome;
  } catch (err) {
    const outcome: JobOutcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    await finishJob(supabase, id, outcome);
    return outcome;
  }
}
