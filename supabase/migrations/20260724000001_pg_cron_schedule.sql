-- pg_cron schedule (docs/10 §2 cron catalog; CLAUDE.md build-order step 6). All times below are
-- UTC (pg_cron's native timezone); IST = UTC+5:30 conversions are noted per job.
--
-- ONE-TIME MANUAL SETUP REQUIRED BEFORE THIS SCHEDULE CAN FIRE SUCCESSFULLY (do this in the
-- Supabase SQL editor against the live project — NEVER put the literal values below into a
-- migration file, they must not enter git history, docs/09 §3):
--
--   1. select vault.create_secret('<the same value as the CRON_SECRET Edge Function secret>', 'cron_secret');
--   2. alter database postgres set app.settings.project_url = 'https://<your-project-ref>.supabase.co';
--   3. supabase secrets set CRON_SECRET=<value> EMAIL_API_KEY=<resend api key> ALERT_EMAIL_TO=<owner email>
--      (ALERT_EMAIL_FROM is optional — defaults to Resend's sandbox sender, see health-check/index.ts)
--
-- Until step 1/2 are done, `cron_invoke_edge_function` raises loudly (fails the cron job run,
-- visible in `cron.job_run_details`) rather than silently no-op-ing or leaking a wrong URL.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- Looks up the cron secret from Vault and the project URL from the GUC set in step 2 above, then
-- fires the Edge Function. security definer so it can read vault.decrypted_secrets (normally
-- restricted) on behalf of whatever role pg_cron runs the job as; never exposed to client roles.
--
-- KNOWN GAP (ops review, build-order step 6): if this function raises — e.g. the one-time setup
-- above wasn't done, or was done wrong — that failure is visible ONLY in cron.job_run_details,
-- never in the job_runs table. The Dashboard banner and health-check's own failure-streak alert
-- both read job_runs exclusively (docs/10 §6), so a misconfigured cron job fails silently from
-- their point of view. Check `select * from cron.job_run_details order by start_time desc limit 20;`
-- manually after first applying this migration to confirm every job actually fired successfully.
create or replace function cron_invoke_edge_function(function_name text, body jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_secret text;
  v_url text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'cron_secret';
  if v_secret is null then
    raise exception 'cron_invoke_edge_function(%): vault secret "cron_secret" not found — see the one-time setup note at the top of this migration', function_name;
  end if;

  v_url := current_setting('app.settings.project_url', true);
  if v_url is null or v_url = '' then
    raise exception 'cron_invoke_edge_function(%): app.settings.project_url is not set — see the one-time setup note at the top of this migration', function_name;
  end if;

  -- This is pg_net's own wait-for-response timeout, not the invoked Edge Function's execution
  -- budget (docs/10 §8) — net.http_post is fire-and-forget from pg_cron's perspective, so the
  -- function keeps running server-side regardless of whether pg_net gives up waiting here.
  -- 60s comfortably covers a slow cold-start without holding a pg_net worker indefinitely.
  perform net.http_post(
    url := v_url || '/functions/v1/' || function_name,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', v_secret),
    body := body,
    timeout_milliseconds := 60000
  );
end;
$$;

revoke execute on function cron_invoke_edge_function(text, jsonb) from public, anon, authenticated;

-- ingest-prices: 18:30 IST Mon-Fri = 13:00 UTC Mon-Fri (skip-if-holiday check inside the function)
select cron.schedule('ingest-prices', '0 13 * * 1-5', $$select cron_invoke_edge_function('ingest-prices')$$);

-- ingest-nav: 22:30 IST daily = 17:00 UTC daily (AMFI publishes late evening)
select cron.schedule('ingest-nav', '0 17 * * *', $$select cron_invoke_edge_function('ingest-nav')$$);

-- ingest-tri: 23:00 IST daily = 17:30 UTC daily
select cron.schedule('ingest-tri', '30 17 * * *', $$select cron_invoke_edge_function('ingest-tri')$$);

-- monthly-run (scheduled): 23:30 IST, days 1-10 = 18:00 UTC, days 1-10 (after prices/NAV/TRI have
-- all landed; days 1-10 covers holiday clusters around month-start — extra firings are free
-- no-ops, the function itself checks "is today the first trading day" and per-user "already has a
-- non-failed run this month", docs/10 §2)
select cron.schedule('monthly-run-scheduled', '0 18 1-10 * *', $$select cron_invoke_edge_function('monthly-run')$$);

-- run-driver: every 10 minutes (no-ops fast when no run is in flight)
select cron.schedule('run-driver', '*/10 * * * *', $$select cron_invoke_edge_function('run-driver')$$);

-- refresh-metrics: Sat 10:00 IST = Sat 04:30 UTC (function exits no-op unless today is the last
-- Saturday of the month)
select cron.schedule('refresh-metrics', '30 4 * * 6', $$select cron_invoke_edge_function('refresh-metrics')$$);

-- health-check: 10:30 IST daily = 05:00 UTC daily (alert email on failure streaks, docs/10 §6)
select cron.schedule('health-check', '0 5 * * *', $$select cron_invoke_edge_function('health-check')$$);

-- job_runs retention only (docs/10 §6: 180 days) — a plain SQL job, no Edge Function needed.
-- NOTE: docs/10 §2's "retention sweep" also covers pruning backups beyond the last 30 daily
-- copies, but export-backup was deliberately not built (owner decision: no backups for this
-- personal instance) — tracked as an open item in docs/07, not scheduled here.
-- Sun 07:30 IST = Sun 02:00 UTC
select cron.schedule(
  'retention-sweep-job-runs',
  '0 2 * * 0',
  $$delete from job_runs where started_at < now() - interval '180 days'$$
);
