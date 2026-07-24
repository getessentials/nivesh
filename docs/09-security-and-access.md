# 09 — Security & Access (RLS matrix, function auth, secrets, ingestion integrity)

Consolidates the security contract previously scattered across docs/06 §5 and docs/07 §14
SEC-1..3. docs/05 implements the RLS section as SQL; this file is the authoritative matrix.

## 1. Access matrix (table × role × operation)

Roles: `anon` (unauthenticated), `user` (authenticated JWT, RLS-scoped), `service` (service-role
key, Edge Functions only). "own" = rows where `user_id = auth.uid()` (directly or via run join).

| Table | anon | user | service |
|---|---|---|---|
| profiles | — | SELECT/INSERT/UPDATE own | all |
| transactions | — | SELECT/INSERT/UPDATE/DELETE own (run_id must be own run — with-check) | all |
| fy_exemption_inputs | — | SELECT/INSERT/UPDATE own | all |
| user_charges_overrides | — | SELECT/INSERT/UPDATE/DELETE own | all |
| run_acknowledgements | — | SELECT/INSERT own | all |
| monthly_runs | — | SELECT own ONLY (no client writes — see §2.3) | all |
| theme_research | — | SELECT (global, no user data) | all |
| recommendation_items | — | SELECT own (via run join) | all |
| feedback_scores | — | SELECT own (pipeline-written) | all |
| holdings (view, security_invoker) | — | SELECT (scoped by transactions RLS) | all |
| themes, etfs, theme_etf_map, indices, nse_holidays | — | SELECT | all |
| etf_prices, etf_navs, index_tri, etf_metrics | — | SELECT | all |
| tax_config, charges_config | — | SELECT | all |
| job_runs | — | SELECT (error strings truncated — see §5) | all |
| metrics_review_queue | — | SELECT (resolution via admin function, §2.1) | all |
| ingest_quarantine | — | SELECT (resolution via admin function, §2.1) | all |

Rules the matrix encodes:
- **No client writes to any reference/market/config table.** A user who could write `tax_config`
  or `etf_prices` corrupts every user's numbers. Global config changes go through migrations or
  service-role tooling only. Per-user preferences (tax slab, broker profile, charge overrides)
  live in `profiles` / `user_charges_overrides` (user-scoped, RLS).
- **Pipeline outputs (`theme_research`, `recommendation_items`) are never client-written** — they
  are produced by Edge Functions with the service role.
- RLS is `ENABLE` + `FORCE` on every table (docs/05); tables without `user_id` get read-only
  policies for `authenticated` and no write policies (writes happen via service role, which
  bypasses RLS by design).

## 2. Edge Function authentication

### 2.1 Auth modes, per function
| Function | User JWT | Cron secret |
|---|---|---|
| ingest-prices / ingest-nav / ingest-tri / refresh-metrics / export-backup / health-check / run-driver / retention-sweep | ✗ (never user-invokable) | ✓ |
| monthly-run (create/"Run now") | ✓ (rate-limited 1/day/user) | ✓ (scheduled: iterates users server-side) |
| pipeline stage functions | ✗ (driver-invoked only) | ✓ |
| **owner-admin functions**: admin-upload-tri (manual TRI CSV → index_tri), admin-submit-metrics (review queue → etf_metrics), admin-resolve-quarantine (accept → market tables / discard), admin-force-research | ✓ AND JWT `sub` ∈ `ADMIN_USER_IDS` (an allowlisted user-id set in Edge Function secrets — the pinned mechanism; no custom-claim auth hook needed) | ✗ |

Owner-admin functions are the ONLY path by which manually supplied data reaches global tables
(the matrix makes those tables client-unwritable); every manual submission passes the same §5
sanity gates as automated ingestion before the service-role write, and admin CSV uploads inherit
the §6 parse limits (UTF-8, 1 MB, 5,000 rows, all-or-nothing).

### 2.2 Mechanics
- pg_cron cannot call HTTP itself; jobs use **pg_net** (`net.http_post`) to invoke function URLs
  with header `x-cron-secret: <CRON_SECRET>`. `CRON_SECRET` lives in **Supabase Vault** and in the
  functions' secrets; it appears in the cron.job SQL only as a `vault.decrypted_secrets` lookup,
  never as a literal. Functions compare the header with a **constant-time comparison**.
  (pg_net availability on the project's plan: `VERIFY-AT-SEED`.)
- User-mode requests: the function validates the JWT and takes `user_id` **from the JWT `sub`
  claim, never from the request body**. A user can only ever trigger/inspect their own run.
- docs/07 SEC-3 is superseded by this section: "all invocations require the user's JWT" applies to
  user-initiated calls only; scheduled/batch calls authenticate with the cron secret.

### 2.3 Client-side `monthly_runs` writes: NONE
RLS is row-level and cannot column-scope an UPDATE, and every `monthly_runs` column is pipeline
or spend-cap state — a user UPDATE grant would let a user rewrite `status` (forcing the driver to
re-run LLM stages) or zero `llm_cost_usd` (the accumulator the global $2 cap sums). So users get
SELECT-own only. The reviewed/superseded-acknowledged UI state lives in the separate user-scoped
`run_acknowledgements` table (docs/05) with own-row RLS. All state-machine transitions are
service-role writes by the driver/stages.

## 3. Secrets inventory
| Secret | Lives in | Never in |
|---|---|---|
| ANTHROPIC_API_KEY | Edge Function secrets | client bundle, SQL, repo |
| service-role key | Supabase-managed (functions runtime) | client bundle, SQL, repo |
| CRON_SECRET | Vault + function secrets | cron.job SQL literals, client, repo |
| EMAIL_API_KEY (Resend, docs/10 §6 — resolved build-order step 6) | Edge Function secrets | client bundle, SQL, repo |
| ALERT_EMAIL_TO / ALERT_EMAIL_FROM (health-check recipient/sender) | Edge Function secrets | client bundle, SQL, repo |
| app.settings.project_url (not a secret, just the project's own URL) | Postgres GUC (`alter database ... set`), set once per environment | — |
| anon key | client bundle (by design, safe only because of RLS) | — |

## 4. Tenancy & signup posture
- **v1: public signups disabled** in Supabase Auth (or allowlist = owner's email). Anyone with the
  project URL + anon key must not be able to self-register, obtain a JWT, and spend the LLM budget.
- Product phase: enabling signups is a gated change requiring a re-run of this review protocol
  — explicitly including: `ingest_quarantine.raw` (full upstream payloads) and `job_runs` being
  SELECT-able by all authenticated users — plus the SEBI gate in CLAUDE.md (registration required
  before personalized output reaches any non-owner user, paid or free). Add to that re-run list
  (security review, build-order step 6): `health-check`'s alert email embeds a raw `user_id` for
  each failed monthly run (`health-check/index.ts`) — harmless today since the only `user_id` that
  can exist is the owner's own, but once other users exist this leaks another user's UUID to the
  owner's inbox via a third party (Resend) with no stated purpose; should be reduced to
  `run_month`-only (or a count) before signups are enabled.
- The LLM spend cap is **global per calendar month** (sum of `monthly_runs.llm_cost_usd` across
  all users and runs, checked before every Anthropic call — docs/10 §7), not per-run state.

## 5. Ingestion integrity (upstream data is untrusted input)
- **Bulk NAV seed** (captn3m0/historical-mf-data): pin to a specific release tag + record its
  SHA-256 checksum in the repo; after import, cross-validate ≥ 20 random (scheme, date) NAVs
  against AMFI NAVAll before accepting the seed.
- **Sanity gates in every ingester** (prices, NAV, TRI): value > 0; |day-over-day move| ≤ 20%
  (configurable per series class); date not in the future; no duplicate (natural key upsert).
  Violations are NOT upserted — they land in `ingest_quarantine` (docs/05) with the raw payload,
  surfaced on the dashboard beside the job-failure banner; the owner resolves (accept/discard).
  The staleness gate (docs/10 §4) covers absence; this covers wrongness.
- Yahoo/NSE/niftyindices parsers are strict: schema drift ⇒ job failure (visible), never partial
  silent ingestion.
- Error strings persisted to `job_runs.error` are truncated (≤ 500 chars) and stripped of raw
  upstream response bodies — `job_runs` is readable by all authenticated users for the dashboard
  banner; full payloads belong only in `ingest_quarantine.raw` (SELECT-only to clients).

## 6. CSV import hardening (extends docs/07 SEC-2)
- UTF-8 only (reject other encodings/BOM mismatches), ≤ 1 MB, ≤ 5,000 rows, strict schema parse,
  all-or-nothing (any malformed row rejects the file).
- **Sequence validation**: the import is simulated against existing lots; any sell that would
  exceed FIFO-available quantity on its trade date rejects the file (no negative positions, ever —
  the same engine check guards single-row sell inserts from the UI, and **buy-row deletes/edits**:
  the whole per-ETF sequence is re-simulated and the change rejected if any later sell becomes
  uncovered).
- **Re-import dedup**: rows matching an existing transaction on (user_id, etf_id, side, qty,
  price_paise, traded_on) are flagged in the import preview as probable duplicates and require
  explicit confirm-or-skip.

## 7. CSV/export output hardening
- All CSV writers escape formula-leading cells (prefix `'` when a cell starts with `=`, `+`, `-`,
  `@`) — ETF names and free-text fields are the vectors.
- Backup exports (docs/10 §5) go to a **private** Storage bucket, service-role write only, path
  `exports/{user_id}/...`, retention **last 30 daily copies** (single figure, matches docs/10 §5
  and the §2 sweep). No public URLs.
- Every exported/downloaded artifact (plan CSV, FY tax report) embeds the disclaimer line as its
  first row (docs/01 §4).

## 8. LLM output rendering & containment (extends docs/07 SEC-1)
- Theses and narratives render as **plain text only** — never interpreted as markdown/HTML.
- Citation URLs are Zod-validated (`https:` scheme, well-formed), displayed with visible domain,
  never auto-fetched or embedded.
- Post-generation numeric check: every numeric token in a Haiku narrative must appear in the
  `factor_json` it was given; on mismatch regenerate once, then fall back to numbers-only display
  (factor table without prose).
- Unchanged from SEC-1: `theme_key` must match seeded `themes`; LLM influence capped at the policy
  factor (≤ 25 % of theme score); zero LLM influence on ETF selection, allocation, or tax.
