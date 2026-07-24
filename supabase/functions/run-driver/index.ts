/**
 * run-driver (docs/10 §2/§3): cron every 10 min, the correctness backstop for the monthly-run
 * pipeline. Direct stage-to-stage chaining (docs/10 §3) handles the common case fast; this
 * function picks up anything whose lease expired (a crashed or slow invocation) or whose ingest
 * wait has come due, and fails a run outright once its current stage has exhausted its 3 attempts.
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse } from '../_shared/http-error.ts';
import { failRun, chainStage, STAGE_FOR_STATUS, MAX_STAGE_ATTEMPTS, type PipelineStatus } from '../_shared/pipeline.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const LEASE_TIMEOUT_MS = 30 * 60_000;

interface CandidateRun { id: string; status: PipelineStatus; stage_attempts: number; fail_reason: string | null }

async function loadCandidateRuns(supabase: SupabaseClient): Promise<CandidateRun[]> {
  const staleBeforeIso = new Date(Date.now() - LEASE_TIMEOUT_MS).toISOString();
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('monthly_runs')
    .select('id, status, stage_attempts, fail_reason')
    .not('status', 'in', '(done,failed,superseded)')
    .or(`stage_started_at.is.null,stage_started_at.lt.${staleBeforeIso}`)
    .or(`next_check_at.is.null,next_check_at.lte.${nowIso}`);
  if (error) throw new Error(`failed to load candidate runs: ${error.message}`);
  return data as CandidateRun[];
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();

    const candidates = await loadCandidateRuns(supabase);
    let failedCount = 0, invokedCount = 0, skippedCount = 0;

    for (const run of candidates) {
      if (run.stage_attempts >= MAX_STAGE_ATTEMPTS) {
        await failRun(supabase, run.id, run.fail_reason ?? 'stage retries exhausted');
        failedCount++;
        continue;
      }
      const stageFn = STAGE_FOR_STATUS[run.status];
      if (!stageFn) { skippedCount++; continue; } // shouldn't happen — every non-terminal status maps to a stage
      await chainStage(stageFn, { runId: run.id });
      invokedCount++;
    }

    return new Response(JSON.stringify({ ok: true, candidates: candidates.length, invoked: invokedCount, failed: failedCount, skipped: skippedCount }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  } catch (err) {
    return errorResponse(err);
  }
});
