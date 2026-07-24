-- Atomic stage-claim RPC for the monthly-run pipeline driver (docs/10 §3, CLAUDE.md's pipeline
-- execution constraint). supabase-js has no way to express "stage_started_at < now() -
-- interval '30 minutes'" as a filter against server-side now() inside a single conditional
-- UPDATE, so the CAS claim lives here as a single atomic statement instead of being
-- read-then-write from the Edge Function (which would race).
create or replace function claim_run_stage(p_run_id uuid, p_expected_status text)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_claimed boolean;
begin
  update monthly_runs
  set stage_started_at = now(), stage_attempts = stage_attempts + 1
  where id = p_run_id
    and status = p_expected_status
    and (stage_started_at is null or stage_started_at < now() - interval '30 minutes')
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end;
$$;

-- Pipeline stages and run-driver are service-role-only callers (docs/09 §2.1); a client-callable
-- CAS claim would let any authenticated user tamper with another user's run lease/attempt count
-- even though they cannot write monthly_runs.status directly (docs/09 §2.3).
revoke execute on function claim_run_stage(uuid, text) from public, anon, authenticated;
grant execute on function claim_run_stage(uuid, text) to service_role;
