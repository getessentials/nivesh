/**
 * stage-finalize (narrated -> done): the last hop in the state machine (docs/10 §3). Runs a
 * defensive invariant check (docs/01 §6 acceptance criteria: Σunits×price <= X_spendable) before
 * marking the run done — this should always hold given stage-allocate's own arithmetic, so a
 * failure here indicates a real bug upstream rather than expected input variance. Driver-invoked
 * only (docs/09 §2.1).
 */
import { verifyCronSecret } from '../_shared/auth.ts';
import { createServiceClient } from '../_shared/supabase-client.ts';
import { errorResponse, HttpError } from '../_shared/http-error.ts';
import { claimStage, completeStage, recordStageFailure } from '../_shared/pipeline.ts';
import type { SupabaseClient } from '@supabase/supabase-js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function verifySpendInvariant(supabase: SupabaseClient, runId: string): Promise<void> {
  const { data: run, error: runErr } = await supabase.from('monthly_runs').select('amount_paise, carry_in_paise').eq('id', runId).single();
  if (runErr) throw new Error(`failed to load run ${runId}: ${runErr.message}`);
  const xSpendablePaise = BigInt((run as { amount_paise: string }).amount_paise) + BigInt((run as { carry_in_paise: string }).carry_in_paise);

  const { data: items, error: itemsErr } = await supabase.from('recommendation_items').select('alloc_paise').eq('run_id', runId).eq('level', 'etf');
  if (itemsErr) throw new Error(`failed to load recommendation_items for run ${runId}: ${itemsErr.message}`);
  const totalAlloc = (items as Array<{ alloc_paise: string | null }>).reduce((sum, r) => sum + (r.alloc_paise ? BigInt(r.alloc_paise) : 0n), 0n);

  if (totalAlloc > xSpendablePaise) {
    throw new Error(`invariant violated: total allocation ${totalAlloc} exceeds X_spendable ${xSpendablePaise} for run ${runId}`);
  }
}

Deno.serve(async (req) => {
  try {
    verifyCronSecret(req);
    const { runId } = await req.json();
    if (typeof runId !== 'string') throw new HttpError(400, 'runId is required');

    const supabase = createServiceClient();
    const claimed = await claimStage(supabase, runId, 'narrated');
    if (!claimed) return jsonResponse({ ok: true, note: 'lease not acquired or run not at narrated' });

    try {
      await verifySpendInvariant(supabase, runId);
      await completeStage(supabase, runId, 'done');
      return jsonResponse({ ok: true, runId, status: 'done' });
    } catch (err) {
      await recordStageFailure(supabase, runId, err);
      return jsonResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
    }
  } catch (err) {
    return errorResponse(err);
  }
});
