/**
 * health-check (docs/10 §6): daily alert email when any of:
 *  - the same job has failed >= 3 consecutive runs in job_runs (same "ok=false OR orphaned
 *    (ok is null, started > 30 min ago)" predicate the Dashboard banner uses, docs/10 §6);
 *  - a monthly_runs row is status='failed', within the last ~26h (a bit over the 24h cron
 *    cadence, so a failure is alerted once per day it's discovered, not forever);
 *  - month-to-date LLM spend >= $0.50 (docs/01 §6 alert threshold; the hard cap is $2,
 *    docs/10 §7 — this is an earlier warning, not the cap itself).
 * The fourth docs/10 §6 trigger ("approaching a detectable free-tier limit") has no concrete,
 * checkable signal from within an Edge Function today — Supabase exposes no quota-remaining API
 * to poll — so it is deliberately NOT implemented here rather than faked; tracked as an open item
 * (docs/07).
 * Never user-invokable (docs/09 §2.1) — cron-secret auth only.
 * Email provider: Resend (the docs/10 §6 "free transactional provider" choice was left as an
 * owner VERIFY-AT-SEED item; resolved here — swap `sendAlertEmail` if a different provider is
 * preferred later). Secrets: EMAIL_API_KEY (docs/09 §3), ALERT_EMAIL_TO, optional ALERT_EMAIL_FROM.
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { runLoggedJob } from '../_shared/job-log.ts';
import { errorResponse } from '../_shared/http-error.ts';
import { requireEnv, optionalEnv } from '../_shared/env.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
const ORPHAN_TIMEOUT_MS = 30 * 60_000; // matches the Dashboard banner's own predicate (docs/10 §6)
const LLM_SPEND_ALERT_USD = 0.5;
const FAILED_RUN_LOOKBACK_HOURS = 26;
// Must comfortably cover 3 CONSECUTIVE runs of the slowest-cadence job in the catalog
// (refresh-metrics is weekly, docs/10 §2) — a 7-day window would only ever contain ONE
// refresh-metrics row, making that job's failure-streak alert structurally unreachable. 35 days
// (5 weeks) covers 3 consecutive weekly runs with buffer for a missed/delayed week.
const JOB_LOOKBACK_DAYS = 35;

interface JobRunRow { job: string; ok: boolean | null; started_at: string }

function isFailedRow(row: JobRunRow): boolean {
  if (row.ok === false) return true;
  if (row.ok === null && Date.now() - new Date(row.started_at).getTime() > ORPHAN_TIMEOUT_MS) return true;
  return false;
}

/** Jobs whose most recent `CONSECUTIVE_FAILURE_THRESHOLD` runs are ALL failed (rows are loaded
 *  newest-first, so the first N per job are its most recent N attempts). */
async function findFailingJobs(supabase: SupabaseClient): Promise<string[]> {
  const since = new Date(Date.now() - JOB_LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from('job_runs')
    .select('job, ok, started_at')
    .gte('started_at', since)
    .order('started_at', { ascending: false });
  if (error) throw new Error(`failed to load job_runs: ${error.message}`);

  const byJob = new Map<string, JobRunRow[]>();
  for (const row of data as JobRunRow[]) {
    const arr = byJob.get(row.job) ?? [];
    arr.push(row);
    byJob.set(row.job, arr);
  }

  const failing: string[] = [];
  for (const [job, rows] of byJob) {
    const mostRecent = rows.slice(0, CONSECUTIVE_FAILURE_THRESHOLD);
    if (mostRecent.length === CONSECUTIVE_FAILURE_THRESHOLD && mostRecent.every(isFailedRow)) failing.push(job);
  }
  return failing;
}

async function findRecentlyFailedRuns(supabase: SupabaseClient): Promise<Array<{ id: string; user_id: string; run_month: string }>> {
  const since = new Date(Date.now() - FAILED_RUN_LOOKBACK_HOURS * 3600_000).toISOString();
  const { data, error } = await supabase
    .from('monthly_runs')
    .select('id, user_id, run_month')
    .eq('status', 'failed')
    .gte('stage_updated_at', since);
  if (error) throw new Error(`failed to load failed monthly_runs: ${error.message}`);
  return data as Array<{ id: string; user_id: string; run_month: string }>;
}

function currentCalendarMonthIst(): string {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000);
  return `${ist.toISOString().slice(0, 7)}-01`; // run_month is always the 1st of the month (monthly-run/index.ts)
}

async function monthToDateLlmSpendUsd(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase.from('monthly_runs').select('llm_cost_usd').eq('run_month', currentCalendarMonthIst());
  if (error) throw new Error(`failed to sum llm_cost_usd: ${error.message}`);
  return (data as Array<{ llm_cost_usd: number }>).reduce((sum, r) => sum + Number(r.llm_cost_usd), 0);
}

async function sendAlertEmail(subjectParts: string[], bodyLines: string[]): Promise<void> {
  const apiKey = requireEnv('EMAIL_API_KEY');
  const to = requireEnv('ALERT_EMAIL_TO');
  const from = optionalEnv('ALERT_EMAIL_FROM') ?? 'NiveshETF Alerts <onboarding@resend.dev>';
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: `NiveshETF alert: ${subjectParts.join('; ')}`, text: bodyLines.join('\n') }),
  });
  if (!res.ok) throw new Error(`Resend API returned HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const supabase = createServiceClient();

    const outcome = await runLoggedJob(supabase, 'health-check', async () => {
      const [failingJobs, failedRuns, llmSpendUsd] = await Promise.all([
        findFailingJobs(supabase),
        findRecentlyFailedRuns(supabase),
        monthToDateLlmSpendUsd(supabase),
      ]);

      const subjectParts: string[] = [];
      const bodyLines: string[] = [];

      if (failingJobs.length > 0) {
        subjectParts.push(`${failingJobs.length} job(s) failing`);
        bodyLines.push(`Jobs with >= ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures: ${failingJobs.join(', ')}`);
      }
      if (failedRuns.length > 0) {
        subjectParts.push(`${failedRuns.length} monthly run(s) failed`);
        for (const r of failedRuns) bodyLines.push(`Run ${r.id} (user ${r.user_id}, month ${r.run_month}) is failed.`);
      }
      if (llmSpendUsd >= LLM_SPEND_ALERT_USD) {
        subjectParts.push(`LLM spend $${llmSpendUsd.toFixed(2)} this month`);
        bodyLines.push(`Month-to-date LLM spend is $${llmSpendUsd.toFixed(2)}, at/above the $${LLM_SPEND_ALERT_USD.toFixed(2)} alert threshold (hard cap $2).`);
      }

      if (subjectParts.length > 0) await sendAlertEmail(subjectParts, bodyLines);
      return { rows: subjectParts.length };
    });

    return new Response(JSON.stringify(outcome), { status: outcome.ok ? 200 : 500, headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return errorResponse(err);
  }
});
