/**
 * monthly-run pipeline state machine mechanics (docs/10 §3, CLAUDE.md's pipeline execution
 * constraint). Every stage Edge Function is built the same shape: claim -> do idempotent work ->
 * complete (advance status) or record-failure (release the lease, leave status for the driver to
 * retry or eventually fail). The atomic claim itself lives in Postgres (`claim_run_stage`,
 * migration 20260723000006) because it needs a server-side `now()` comparison that supabase-js
 * cannot express as a single conditional UPDATE.
 */
import { requireEnv } from './env.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

export type PipelineStatus =
  | 'pending' | 'research' | 'gated' | 'theme_ranked' | 'etf_ranked' | 'allocated' | 'narrated'
  | 'done' | 'failed' | 'superseded';

/** docs/10 §3: max 3 attempts per stage before the driver gives up and fails the run. */
export const MAX_STAGE_ATTEMPTS = 3;

const MAX_FAIL_REASON_LEN = 500; // matches the job_runs.error CHECK constraint convention

/** Maps the status a run is CURRENTLY sitting at to the Edge Function that advances it past that
 *  status (docs/10 §3's seven-stage chain). Shared by monthly-run (first invocation), stage
 *  chaining, and run-driver (retry/backstop). */
export const STAGE_FOR_STATUS: Partial<Record<PipelineStatus, string>> = {
  pending: 'stage-research',
  research: 'stage-gate',
  gated: 'stage-theme-rank',
  theme_ranked: 'stage-etf-rank',
  etf_ranked: 'stage-allocate',
  allocated: 'stage-narrate',
  narrated: 'stage-finalize',
};

/**
 * Atomic CAS claim (docs/10 §3): true if this invocation now holds the lease on `runId`, having
 * verified it was sitting at `expectedStatus` with no live (or only stale) lease. False means
 * another invocation already holds the lease, or the run has moved past this status — either way
 * the caller must exit immediately without doing any work.
 */
export async function claimStage(
  supabase: SupabaseClient,
  runId: string,
  expectedStatus: PipelineStatus
): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_run_stage', {
    p_run_id: runId,
    p_expected_status: expectedStatus,
  });
  if (error) throw new Error(`claim_run_stage RPC failed for run ${runId}: ${error.message}`);
  return data === true;
}

/** Advances the run past the stage that just completed successfully, clearing the lease and
 *  resetting the attempt counter (docs/10 §3: "resets stage_attempts=0 and stage_started_at=null,
 *  sets stage_updated_at=now()" — the next stage starts its own attempt count from zero). Also
 *  clears `next_check_at`, since a completed stage is by definition no longer waiting. */
export async function completeStage(
  supabase: SupabaseClient,
  runId: string,
  nextStatus: PipelineStatus,
  extraFields: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await supabase
    .from('monthly_runs')
    .update({
      status: nextStatus,
      stage_attempts: 0,
      stage_started_at: null,
      stage_updated_at: new Date().toISOString(),
      next_check_at: null,
      ...extraFields,
    })
    .eq('id', runId);
  if (error) throw new Error(`failed to complete stage for run ${runId} -> ${nextStatus}: ${error.message}`);
}

/**
 * Releases the lease after a failed attempt WITHOUT marking the run failed — the attempt counter
 * (already incremented by `claimStage`) stays incremented, so this genuinely counts as one of the
 * 3 allowed attempts (docs/10 §3). `fail_reason` is used as a scratch "most recent error" slot
 * even before the run is terminally failed; the run-driver overwrites/keeps it when it eventually
 * gives up and sets status='failed'.
 */
export async function recordStageFailure(supabase: SupabaseClient, runId: string, err: unknown): Promise<void> {
  const message = (err instanceof Error ? err.message : String(err)).slice(0, MAX_FAIL_REASON_LEN);
  const { error } = await supabase
    .from('monthly_runs')
    .update({ fail_reason: message, stage_started_at: null, stage_updated_at: new Date().toISOString() })
    .eq('id', runId);
  if (error) throw new Error(`failed to record stage failure for run ${runId}: ${error.message}`);
}

/** Terminal failure (docs/10 §3/§2): status='failed', lease cleared. Used both by the run-driver
 *  (max attempts exhausted) and by a stage's own ingest-precondition deadline check (docs/10 §2:
 *  past 12:00 IST the day after the run date -> `fail_reason='ingest_missing'`). */
export async function failRun(supabase: SupabaseClient, runId: string, reason: string): Promise<void> {
  const { error } = await supabase
    .from('monthly_runs')
    .update({
      status: 'failed',
      fail_reason: reason.slice(0, MAX_FAIL_REASON_LEN),
      stage_started_at: null,
      stage_updated_at: new Date().toISOString(),
    })
    .eq('id', runId);
  if (error) throw new Error(`failed to mark run ${runId} failed: ${error.message}`);
}

/**
 * Ingest-precondition wait-exit (docs/10 §2): releases the lease and DECREMENTS the attempt
 * counter the CAS claim just incremented — "waiting is NOT a stage attempt" — then schedules the
 * next hourly re-check. Only `stage-research` calls this (it's the only stage with an upstream
 * data precondition); every other stage's inputs are already the pipeline's own prior-stage
 * output, which has no such wait.
 */
export async function waitStage(supabase: SupabaseClient, runId: string, nextCheckAtIso: string): Promise<void> {
  const { data, error } = await supabase.from('monthly_runs').select('stage_attempts').eq('id', runId).single();
  if (error) throw new Error(`failed to read stage_attempts for run ${runId}: ${error.message}`);
  const decremented = Math.max(0, Number((data as { stage_attempts: number }).stage_attempts) - 1);
  const { error: updErr } = await supabase
    .from('monthly_runs')
    .update({ stage_attempts: decremented, stage_started_at: null, next_check_at: nextCheckAtIso })
    .eq('id', runId);
  if (updErr) throw new Error(`failed to record wait-exit for run ${runId}: ${updErr.message}`);
}

/**
 * Best-effort direct stage-to-stage chaining for latency (docs/10 §3: "stages may also chain
 * directly ... the driver is the correctness backstop"). Never throws — a failure here just means
 * the next run-driver tick (<=10 min later) picks the run up instead; that's the documented
 * fallback, not an error condition.
 */
export async function chainStage(functionName: string, body: Record<string, unknown>): Promise<void> {
  try {
    const baseUrl = requireEnv('SUPABASE_URL').replace(/\/$/, '');
    await fetch(`${baseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': requireEnv('CRON_SECRET') },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error(`chainStage: best-effort invocation of ${functionName} failed (driver will retry):`, err);
  }
}
