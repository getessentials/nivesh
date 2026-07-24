# 11 — Deployment Checklist (everything left after build-order step 6)

All code, migrations, and Edge Functions are written and reviewed (docs/07 §0/§14, build-order
steps 1–6). Nothing left is a code change — it's account setup, credentials, and CLI/dashboard
actions against live Supabase + Vercel projects. This doc is the punch list; check items off (or
hand this doc to Claude and ask it to work through it) as they're done.

Owner action required = something only the account owner can do (sign up for a service, choose a
password, click a dashboard button that needs 2FA, etc.). Claude can do it given credentials =
mechanical CLI/API work Claude can execute directly once it has the right access (see §5 for how
to hand off credentials safely).

## 1. Accounts to create (owner action required)
- [ ] Supabase project (if not already created) — note the project ref (`xxxx` in
  `https://xxxx.supabase.co`).
- [ ] Resend account (docs/10 §6, resolved build-order step 6) — verify a sending domain, or use
  the sandbox sender `onboarding@resend.dev` (only delivers to the account's own verified email —
  fine for a single-owner personal tool). Get an API key.
- [ ] Vercel account + project linked to this repo.
- [ ] Decide the owner's login email for Supabase Auth (docs/09 §4 — signups must be disabled or
  allowlisted to this one address).

## 2. Git
- [ ] Initial commit + push to a remote (owner is doing this step themselves — see chat history).
  Nothing below can happen from Vercel's side until this exists, since Vercel deploys from git.

## 3. Supabase — one-time setup (Claude can do this given a Supabase access token + project ref/DB
   connection string, via the `supabase` CLI or direct `psql`)
- [ ] `supabase link --project-ref <ref>`
- [ ] `supabase db push` — applies every migration in `supabase/migrations/`, including
  `20260724000001_pg_cron_schedule.sql` (the cron schedule itself; it fails loudly rather than
  silently no-op'ing if the next two steps aren't done first — see that file's header comment).
- [ ] In the Supabase SQL editor (or via `supabase db execute`), run, with REAL values substituted
  (never commit these, never put them in a migration file — docs/09 §3):
  ```sql
  select vault.create_secret('<the same value you set as the CRON_SECRET function secret below>', 'cron_secret');
  select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
  ```
  (Not `alter database ... set app.settings.project_url` — Supabase's hosted Postgres denies
  custom database-level GUCs to every role, including the dashboard SQL editor's `postgres` role,
  which is not real superuser there. Vault has no such restriction.)
- [ ] `supabase secrets set CRON_SECRET=<value> ANTHROPIC_API_KEY=<value> EMAIL_API_KEY=<resend key> ALERT_EMAIL_TO=<owner email>`
  (`ALERT_EMAIL_FROM` optional — defaults to the Resend sandbox sender; `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` are auto-provided to Edge Functions by Supabase, no need to set them).
- [ ] `supabase functions deploy` (deploys all functions in `supabase/functions/` — ingest-nav,
  ingest-prices, ingest-tri, monthly-run, refresh-metrics, run-driver, stage-*, health-check).
- [ ] Confirm `pg_cron`/`pg_net` extensions are enabled for the project (the migration
  `create extension if not exists`s them, but confirm on the project's plan tier this is allowed —
  docs/10 §8 VERIFY-AT-SEED item).
- [ ] Supabase Auth settings: disable public signups (or set an email allowlist to the owner's
  address only, docs/09 §4) — do this BEFORE deploying the frontend publicly.
- [ ] Supabase Auth settings: add the eventual Vercel production URL (and any preview-deploy
  pattern) to the allowed redirect URLs, so magic-link sign-in (`LoginPage.tsx`) actually redirects
  back to the deployed app instead of localhost.

## 4. Vercel (Claude can do this given a Vercel token, via the `vercel` CLI)
- [ ] Link the project; set **Root Directory = `apps/web`** (the monorepo has the frontend nested
  under `apps/web` — `apps/web/vercel.json` already sets the build/install commands and SPA
  rewrite, but Root Directory is a project-setting, not expressible in that file).
- [ ] Set environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (both from the
  Supabase project settings → API), and optionally `VITE_ADMIN_USER_IDS` (comma-separated auth
  user UUIDs — a client-side UX hint only, not a security boundary, docs/09 §2.1 already covers
  the real server-side gate).
- [ ] Deploy (`vercel --prod` or push to the connected git branch).

## 5. Handing off credentials safely
Prefer NOT pasting raw tokens into chat — they'd sit in conversation history. Safer options, in
order of preference:
1. Run `supabase login` / `vercel login` yourself in a terminal (or via `! <command>` in this
   session) — this stores an auth session on this machine; Claude can then run `supabase`/`vercel`
   commands using that already-authenticated session without ever seeing the token itself.
2. Export a token as a shell environment variable in this session (`export SUPABASE_ACCESS_TOKEN=...`
   via `!`) rather than typing it into a chat message — Claude can read it from the environment
   when invoking the CLI, and it won't appear in this transcript.
3. If a token must be typed into chat, treat it as compromised afterward and rotate it once setup
   is done.

## 5a. Running everything locally instead of (or before) deploying
The full stack can run entirely on one machine, no Vercel/cloud-Supabase project needed:
- `supabase start` — the Supabase CLI's local dev stack (Docker): local Postgres, Auth, Storage,
  and an Edge Functions runtime, all on localhost.
- `supabase functions serve` — serves the Edge Functions locally against that local Postgres.
- `pnpm --filter @niveshetf/web dev` — the frontend, pointed at the local Supabase URL/anon key
  via `apps/web/.env` (copy `.env.example`).
- Same one-time setup as §3 (vault secret, GUC, `supabase secrets set`) applies, just run against
  the local instance instead of (or in addition to) the cloud project.
- `pg_cron` is not enabled by default in local dev — enable it in `supabase/config.toml` if you
  want the schedule to actually fire locally, but for local iteration it's usually simpler to just
  `curl` each function directly (ingest-prices, monthly-run, etc.) instead of waiting on cron.
- Local Postgres is a SEPARATE database from the cloud project — data doesn't cross over either way.
- External calls (Yahoo/AMFI/niftyindices market data, the Anthropic API) always hit the real
  internet and cost/behave the same regardless of local vs. cloud — only Supabase itself
  (DB/Auth/Functions/cron) is local in this setup.

## 6. Post-deploy smoke test
- [ ] Manually invoke `health-check` once (`curl -X POST https://<ref>.supabase.co/functions/v1/health-check -H "x-cron-secret: <value>"`)
  to confirm the Resend integration actually sends before waiting for the 05:00 UTC schedule.
- [ ] After the first migration push, check `select * from cron.job_run_details order by start_time desc limit 20;`
  to confirm every scheduled job fired successfully (docs/10 §2 implementation note — a
  misconfigured `cron_invoke_edge_function` fails ONLY here, never in `job_runs`, so this is the
  one place that failure would be visible).
- [ ] Sign in via magic link on the deployed Vercel URL, complete onboarding, click "Run now" once
  price/NAV/TRI data has been ingested for a few days, and confirm a plan comes back — the true
  end-to-end test that every piece (frontend → Edge Functions → LLM → deterministic engine) is
  wired correctly in production, not just individually reviewed.

## 7. Explicitly deferred (owner decision, not forgotten — docs/07 §13 items 9/15)
- `export-backup` was not built — no backups for this personal instance. No recovery path for
  user data beyond whatever Supabase's own plan tier provides.
- The "approaching a free-tier limit" health-check alert trigger was not implemented — no
  concrete, pollable signal exists for it.
