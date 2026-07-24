import { assert, assertEquals } from '@std/assert';
import {
  claimStage, completeStage, recordStageFailure, failRun, waitStage, STAGE_FOR_STATUS,
} from './pipeline.ts';

/** Minimal duck-typed fake standing in for the slice of SupabaseClient pipeline.ts actually
 *  calls: `.rpc()` and the `.from(table).{update,select}(...).eq(...).[single()]` chain. Records
 *  every call so tests can assert on exactly what was sent, without a live database. */
function fakeSupabase(opts: {
  rpcResult?: { data: unknown; error: { message: string } | null };
  selectResult?: { data: unknown; error: { message: string } | null };
  updateError?: { message: string } | null;
}) {
  const calls: { rpc: unknown[]; update: unknown[]; select: unknown[] } = { rpc: [], update: [], select: [] };
  const client = {
    rpc(name: string, args: unknown) {
      calls.rpc.push({ name, args });
      return Promise.resolve(opts.rpcResult ?? { data: null, error: null });
    },
    from(_table: string) {
      return {
        update(payload: unknown) {
          calls.update.push(payload);
          return {
            eq(_col: string, _val: unknown) {
              return Promise.resolve({ error: opts.updateError ?? null });
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, _val: unknown) {
              return {
                single: () => Promise.resolve(opts.selectResult ?? { data: null, error: null }),
              };
            },
          };
        },
      };
    },
  };
  // deno-lint-ignore no-explicit-any
  return { client: client as any, calls };
}

Deno.test('claimStage returns true when the RPC reports a successful claim', async () => {
  const { client } = fakeSupabase({ rpcResult: { data: true, error: null } });
  assertEquals(await claimStage(client, 'run-1', 'pending'), true);
});

Deno.test('claimStage returns false when the RPC reports no rows claimed', async () => {
  const { client } = fakeSupabase({ rpcResult: { data: false, error: null } });
  assertEquals(await claimStage(client, 'run-1', 'pending'), false);
});

Deno.test('claimStage throws on an RPC error rather than treating it as "not claimed"', async () => {
  const { client } = fakeSupabase({ rpcResult: { data: null, error: { message: 'boom' } } });
  let threw = false;
  try {
    await claimStage(client, 'run-1', 'pending');
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test('completeStage sends the next status and resets the lease/attempts', async () => {
  const { client, calls } = fakeSupabase({});
  await completeStage(client, 'run-1', 'gated');
  assertEquals(calls.update.length, 1);
  const payload = calls.update[0] as Record<string, unknown>;
  assertEquals(payload.status, 'gated');
  assertEquals(payload.stage_attempts, 0);
  assertEquals(payload.stage_started_at, null);
  assertEquals(payload.next_check_at, null);
});

Deno.test('recordStageFailure truncates a long error message to the job_runs.error length cap', async () => {
  const { client, calls } = fakeSupabase({});
  const longMessage = 'x'.repeat(1000);
  await recordStageFailure(client, 'run-1', new Error(longMessage));
  const payload = calls.update[0] as Record<string, unknown>;
  assertEquals((payload.fail_reason as string).length, 500);
  assertEquals(payload.stage_started_at, null);
});

Deno.test('failRun sets status=failed with the given reason', async () => {
  const { client, calls } = fakeSupabase({});
  await failRun(client, 'run-1', 'ingest_missing');
  const payload = calls.update[0] as Record<string, unknown>;
  assertEquals(payload.status, 'failed');
  assertEquals(payload.fail_reason, 'ingest_missing');
});

Deno.test('waitStage decrements stage_attempts (waiting is not a stage attempt)', async () => {
  const { client, calls } = fakeSupabase({ selectResult: { data: { stage_attempts: 1 }, error: null } });
  await waitStage(client, 'run-1', '2026-07-24T01:00:00.000Z');
  const payload = calls.update[0] as Record<string, unknown>;
  assertEquals(payload.stage_attempts, 0);
  assertEquals(payload.next_check_at, '2026-07-24T01:00:00.000Z');
});

Deno.test('waitStage floors the decrement at zero rather than going negative', async () => {
  const { client, calls } = fakeSupabase({ selectResult: { data: { stage_attempts: 0 }, error: null } });
  await waitStage(client, 'run-1', '2026-07-24T01:00:00.000Z');
  const payload = calls.update[0] as Record<string, unknown>;
  assertEquals(payload.stage_attempts, 0);
});

Deno.test('STAGE_FOR_STATUS covers every non-terminal status with the correct next stage function', () => {
  assertEquals(STAGE_FOR_STATUS.pending, 'stage-research');
  assertEquals(STAGE_FOR_STATUS.research, 'stage-gate');
  assertEquals(STAGE_FOR_STATUS.gated, 'stage-theme-rank');
  assertEquals(STAGE_FOR_STATUS.theme_ranked, 'stage-etf-rank');
  assertEquals(STAGE_FOR_STATUS.etf_ranked, 'stage-allocate');
  assertEquals(STAGE_FOR_STATUS.allocated, 'stage-narrate');
  assertEquals(STAGE_FOR_STATUS.narrated, 'stage-finalize');
  assertEquals(STAGE_FOR_STATUS.done, undefined);
  assertEquals(STAGE_FOR_STATUS.failed, undefined);
  assertEquals(STAGE_FOR_STATUS.superseded, undefined);
});
