/** monthly_runs read/write helpers shared by monthly-run (create/resume) and the pipeline
 *  stages — the re-run semantics (docs/01 §3.5) and carry-in rule (docs/03 §4 step 5) live here
 *  once so no stage re-derives them differently. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PipelineStatus } from './pipeline.ts';

export interface MonthlyRunRow {
  id: string;
  user_id: string;
  run_month: string;
  seq: number;
  amount_paise: string;
  carry_in_paise: string;
  residual_paise: string | null;
  research_month: string | null;
  status: PipelineStatus;
  fail_reason: string | null;
  stage_attempts: number;
}

/** Every status except the three terminal ones (docs/10 §3). */
export const TERMINAL_STATUSES: ReadonlySet<PipelineStatus> = new Set(['done', 'failed', 'superseded']);

export async function loadLatestRunForMonth(
  supabase: SupabaseClient,
  userId: string,
  runMonth: string
): Promise<MonthlyRunRow | null> {
  const { data, error } = await supabase
    .from('monthly_runs')
    .select('*')
    .eq('user_id', userId)
    .eq('run_month', runMonth)
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`failed to load latest run for user ${userId} / ${runMonth}: ${error.message}`);
  return data as MonthlyRunRow | null;
}

/**
 * carry_in source (docs/03 §4 step 5): the most recent DONE run — `status='done'` already
 * excludes superseded runs, since superseding flips the old run's status away from 'done' — with
 * an earlier (run_month, seq) than the run being created. Returns 0 when no such run exists (the
 * very first run ever, or every prior run failed/was superseded without ever completing).
 */
export async function residualCarryInPaise(
  supabase: SupabaseClient,
  userId: string,
  beforeRunMonth: string,
  beforeSeq: number
): Promise<bigint> {
  const { data, error } = await supabase
    .from('monthly_runs')
    .select('residual_paise')
    .eq('user_id', userId)
    .eq('status', 'done')
    .or(`run_month.lt.${beforeRunMonth},and(run_month.eq.${beforeRunMonth},seq.lt.${beforeSeq})`)
    .order('run_month', { ascending: false })
    .order('seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`failed to resolve carry-in for user ${userId} before ${beforeRunMonth}/${beforeSeq}: ${error.message}`);
  const row = data as { residual_paise: string | null } | null;
  return row?.residual_paise ? BigInt(row.residual_paise) : 0n;
}

/** Sum of buy consideration (qty*price) for lots already booked against a specific run this
 *  month (docs/01 §3.5's "already deployed ₹Y against the superseded plan"). */
export async function sumDeployedAgainstRunPaise(supabase: SupabaseClient, runId: string): Promise<bigint> {
  const { data, error } = await supabase
    .from('transactions')
    .select('qty, price_paise')
    .eq('run_id', runId)
    .eq('side', 'buy');
  if (error) throw new Error(`failed to sum deployed consideration for run ${runId}: ${error.message}`);
  return (data as Array<{ qty: number; price_paise: string }>).reduce(
    (sum, r) => sum + BigInt(r.qty) * BigInt(r.price_paise),
    0n
  );
}
