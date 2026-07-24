/**
 * monthly-run: the pipeline entrypoint (docs/01 §3.2, §3.5; docs/09 §2.1). Two callers:
 *   - User "Run now" (JWT): creates or resumes ONE user's run, with the re-run confirmation flow.
 *   - Scheduled cron (cron secret): iterates every onboarded user server-side, creating a fresh
 *     run only for users with no non-failed run yet this month (docs/10 §2 cron catalog).
 * This function only creates/resumes the `monthly_runs` row and kicks off stage-research; all
 * actual pipeline work happens in the chained stage functions (docs/10 §3).
 */
import { verifyCronSecret, verifyUserJwt } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { userFacingErrorResponse, HttpError } from '../_shared/http-error.ts';
import { chainStage, STAGE_FOR_STATUS, type PipelineStatus } from '../_shared/pipeline.ts';
import { loadLatestRunForMonth, residualCarryInPaise, sumDeployedAgainstRunPaise, TERMINAL_STATUSES } from '../_shared/run-repo.ts';
import { firstTradingDayOfMonth } from '../_shared/shared-lib.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function currentCalendarMonth(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 7);
}

async function loadHolidays(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from('nse_holidays').select('d');
  if (error) throw new Error(`failed to load nse_holidays: ${error.message}`);
  return new Set((data as Array<{ d: string }>).map((r) => r.d));
}

interface CreateRunResult { run: { id: string; status: PipelineStatus }; created: true }

async function createRun(
  supabase: SupabaseClient,
  userId: string,
  runMonth: string,
  seq: number,
  amountPaise: bigint,
  carryInPaise: bigint
): Promise<CreateRunResult> {
  const { data, error } = await supabase
    .from('monthly_runs')
    .insert({
      user_id: userId,
      run_month: runMonth,
      seq,
      amount_paise: amountPaise.toString(),
      carry_in_paise: carryInPaise.toString(),
      status: 'pending',
    })
    .select('id, status')
    .single();
  if (error) throw new Error(`failed to create monthly_runs row: ${error.message}`);
  await chainStage('stage-research', { runId: (data as { id: string }).id });
  return { run: data as { id: string; status: PipelineStatus }, created: true };
}

/** Resumes an in-flight run by re-invoking whichever stage function handles its current status —
 *  a "Run now" click over an already-running month is a latency nudge, not a new attempt; the
 *  stage's own CAS claim harmlessly no-ops if nothing has actually changed. */
async function resumeRun(run: { id: string; status: PipelineStatus }): Promise<void> {
  const stageFn = STAGE_FOR_STATUS[run.status];
  if (stageFn) await chainStage(stageFn, { runId: run.id });
}

async function loadDefaultAmountPaise(supabase: SupabaseClient, userId: string): Promise<bigint> {
  const { data, error } = await supabase.from('profiles').select('default_amount_paise').eq('user_id', userId).single();
  if (error) throw new Error(`failed to load profile for user ${userId}: ${error.message}`);
  return BigInt((data as { default_amount_paise: string }).default_amount_paise);
}

const RATE_LIMIT_WINDOW_HOURS = 24;

async function withinDailyRateLimit(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_HOURS * 3600_000).toISOString();
  const { count, error } = await supabase
    .from('monthly_runs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', since);
  if (error) throw new Error(`failed to check monthly-run rate limit for user ${userId}: ${error.message}`);
  return (count ?? 0) === 0;
}

/** Handles ONE user's "Run now" (or the per-user body of a cron sweep). `body` carries the
 *  user-supplied fields only in JWT mode; cron mode passes neither (no confirmation flow — a
 *  scheduled run never supersedes, per docs/01 §3.5/docs/10 §2). */
async function handleUserRun(
  supabase: SupabaseClient,
  userId: string,
  runMonth: string,
  opts: { amountPaise?: bigint; confirmSupersede?: boolean; enforceRateLimit: boolean; isCron: boolean }
): Promise<Response> {
  const latest = await loadLatestRunForMonth(supabase, userId, runMonth);

  if (latest && !TERMINAL_STATUSES.has(latest.status)) {
    // In flight — resume, don't create (docs/01 §3.5).
    if (opts.isCron) return jsonResponse({ ok: true, note: 'already in flight, no cron action' });
    await resumeRun({ id: latest.id, status: latest.status });
    return jsonResponse({ runId: latest.id, status: latest.status, resumed: true, created: false });
  }

  if (opts.isCron && latest && latest.status !== 'failed') {
    // done or superseded — cron never auto-recreates/supersedes (docs/10 §2: "skips any user who
    // already has a non-failed run for the month").
    return jsonResponse({ ok: true, note: 'non-failed run already exists this month, cron skipped' });
  }

  if (opts.enforceRateLimit && !(await withinDailyRateLimit(supabase, userId))) {
    return jsonResponse({ error: 'rate limit: at most one new monthly-run per user per 24h' }, 429);
  }

  const seq = latest ? latest.seq + 1 : 1;
  const amountPaise = opts.amountPaise ?? (await loadDefaultAmountPaise(supabase, userId));

  if (latest?.status === 'done') {
    // Supersede-a-done-plan confirmation flow (docs/01 §3.5).
    const alreadyDeployedPaise = await sumDeployedAgainstRunPaise(supabase, latest.id);
    const oldAmountPaise = BigInt(latest.amount_paise);
    const suggestedAmountPaise = oldAmountPaise > alreadyDeployedPaise ? oldAmountPaise - alreadyDeployedPaise : 0n;
    const excessDeployedPaise = alreadyDeployedPaise > oldAmountPaise ? alreadyDeployedPaise - oldAmountPaise : 0n;

    if (!opts.confirmSupersede) {
      return jsonResponse({
        needsConfirmation: true,
        supersededRunId: latest.id,
        alreadyDeployedPaise: alreadyDeployedPaise.toString(),
        suggestedAmountPaise: suggestedAmountPaise.toString(),
      }, 409);
    }

    const carryInBase = await residualCarryInPaise(supabase, userId, runMonth, seq);
    // "the excess is deducted from the carry-in shown for the new run" (docs/01 §3.5) — floored
    // at 0 so a large overspend can never push carry-in negative.
    const carryInPaise = carryInBase > excessDeployedPaise ? carryInBase - excessDeployedPaise : 0n;

    const { error: supersedeErr } = await supabase.from('monthly_runs').update({ status: 'superseded' }).eq('id', latest.id);
    if (supersedeErr) throw new Error(`failed to mark run ${latest.id} superseded: ${supersedeErr.message}`);

    const result = await createRun(supabase, userId, runMonth, seq, amountPaise, carryInPaise);
    return jsonResponse({ runId: result.run.id, status: result.run.status, created: true, supersededRunId: latest.id });
  }

  // Fresh run: either the first run of the month, or a "Run now" over a run that failed
  // (no confirmation required — docs/01 §3.5: "a failed run produced no plan to replace").
  const carryInPaise = await residualCarryInPaise(supabase, userId, runMonth, seq);
  const result = await createRun(supabase, userId, runMonth, seq, amountPaise, carryInPaise);
  return jsonResponse({ runId: result.run.id, status: result.run.status, created: true });
}

Deno.serve(async (req) => {
  try {
    const hasCronSecret = req.headers.has('x-cron-secret');
    const supabase = createServiceClient();

    if (hasCronSecret) {
      verifyCronSecret(req);
      const holidays = await loadHolidays(supabase);
      const yyyyMM = currentCalendarMonth();
      const runMonth = `${yyyyMM}-01`;
      const today = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
      if (today !== firstTradingDayOfMonth(yyyyMM, holidays)) {
        return jsonResponse({ ok: true, note: 'no-op: not the first trading day of the month' });
      }

      const { data: profileRows, error } = await supabase.from('profiles').select('user_id');
      if (error) throw new Error(`failed to load profiles for scheduled monthly-run: ${error.message}`);

      let created = 0, skipped = 0;
      for (const { user_id } of profileRows as Array<{ user_id: string }>) {
        const res = await handleUserRun(supabase, user_id, runMonth, { enforceRateLimit: false, isCron: true });
        const body = await res.json();
        if (body.created) created++; else skipped++;
      }
      return jsonResponse({ ok: true, created, skipped });
    }

    // User-initiated "Run now".
    const { userId } = await verifyUserJwt(req);
    const payload = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const runMonth = `${currentCalendarMonth()}-01`;
    const amountPaise = payload.amountPaise !== undefined ? BigInt(payload.amountPaise) : undefined;
    if (amountPaise !== undefined && amountPaise < 0n) throw new HttpError(400, 'amountPaise must not be negative');

    return await handleUserRun(supabase, userId, runMonth, {
      amountPaise,
      confirmSupersede: payload.confirmSupersede === true,
      enforceRateLimit: true,
      isCron: false,
    });
  } catch (err) {
    return userFacingErrorResponse(err);
  }
});
