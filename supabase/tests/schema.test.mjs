// Build-step-1 tests: apply all migrations to a real (embedded) Postgres with a Supabase
// auth shim, then assert schema integrity, config non-overlap, seed completeness, and RLS
// behavior. Run: npm run test:schema
import EmbeddedPostgres from 'embedded-postgres';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');
const dataDir = join(here, '.pgdata');
const PORT = 55439;

let failures = 0;
let passes = 0;
function check(cond, msg) {
  if (cond) { passes++; console.log(`  ok   ${msg}`); }
  else { failures++; console.error(`  FAIL ${msg}`); }
}
async function expectError(client, sql, msg) {
  try { await client.query(sql); check(false, `${msg} (no error raised)`); }
  catch { await client.query('rollback').catch(() => {}); check(true, msg); }
}

rmSync(dataDir, { recursive: true, force: true });
const epg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: false,
});
await epg.initialise();
await epg.start();
await epg.createDatabase('nivesh_test');

const client = new pg.Client({
  host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'nivesh_test',
});
await client.connect();

try {
  // ---- Supabase shim: auth schema, auth.uid(), roles ----
  await client.query(`
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid stable language sql
      as $$ select nullif(current_setting('app.uid', true), '')::uuid $$;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema public, auth to anon, authenticated, service_role;
  `);

  // ---- Apply migrations in filename order ----
  const files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  console.log(`Applying ${files.length} migrations:`);
  for (const f of files) {
    console.log(`  - ${f}`);
    await client.query(readFileSync(join(migrationsDir, f), 'utf8'));
  }

  // Supabase-default-style grants — RLS is the ONLY enforcement layer; Supabase grants base
  // table privileges to both anon and authenticated by default, so the anon-denial test below
  // must exercise real RLS policy scope, not the absence of a GRANT (else a future policy typo
  // like "to public" would pass this suite while being exploitable in production).
  await client.query(`
    grant select, insert, update, delete on all tables in schema public to authenticated;
    grant usage on all sequences in schema public to authenticated;
    grant select on auth.users to authenticated;
    grant select, insert, update, delete on all tables in schema public to anon;
    grant usage on all sequences in schema public to anon;
  `);

  // ================= Structural & seed assertions =================
  console.log('\nSeed integrity:');
  const q = async (sql) => (await client.query(sql)).rows;

  const [{ n: themeCount }] = await q(`select count(*)::int as n from themes`);
  check(themeCount === 15, `15 themes seeded (got ${themeCount})`);

  const [{ n: badInvestable }] = await q(
    `select count(*)::int as n from themes where investable and benchmark_index is null`);
  check(badInvestable === 0, 'every investable theme has a benchmark series');

  const [{ n: unmapped }] = await q(`
    select count(*)::int as n from themes t
    where t.investable and not exists (select 1 from theme_etf_map m where m.theme_key = t.key)`);
  check(unmapped === 0, 'every investable theme has >=1 mapped ETF');

  const [{ n: etfCount }] = await q(`select count(*)::int as n from etfs`);
  check(etfCount >= 25, `ETF universe seeded (${etfCount} ETFs, expected >=25)`);

  const [{ n: badIsin }] = await q(
    `select count(*)::int as n from etfs where isin !~ '^IN[A-Z0-9]{10}$'`);
  check(badIsin === 0, 'all ISINs match the 12-char IN* format');

  const [{ n: noCode }] = await q(
    `select count(*)::int as n from etfs where amfi_scheme_code is null`);
  check(noCode === 0, 'every ETF has an AMFI scheme code');

  const [{ n: navProxies }] = await q(
    `select count(*)::int as n from indices where tri_source = 'nav_proxy' and proxy_etf_id is not null`);
  check(navProxies === 4, `4 nav_proxy benchmark series pinned (got ${navProxies})`);

  const noListing = await q(`select name from etfs where listed_on is null`);
  if (noListing.length > 0)
    console.log(`  note: ${noListing.length} ETFs have null listed_on (G2 will exclude them until verified): ${noListing.map(r => r.name).join('; ')}`);

  const [{ n: holidays }] = await q(
    `select count(*)::int as n from nse_holidays where extract(year from d) = 2026`);
  check(holidays >= 10, `NSE 2026 holiday calendar seeded (${holidays} days)`);

  // tax_config: 2-D (sell-date x buy-date) non-overlap within asset_class — docs/04 §1
  const [{ n: overlaps }] = await q(`
    select count(*)::int as n
    from tax_config a join tax_config b on a.asset_class = b.asset_class and a.id < b.id
    where daterange(a.effective_from, coalesce(a.effective_to, date '9999-12-31'), '[]')
       && daterange(b.effective_from, coalesce(b.effective_to, date '9999-12-31'), '[]')
      and daterange(coalesce(a.acquired_from, date '0001-01-01'), coalesce(a.acquired_to, date '9999-12-31'), '[]')
       && daterange(coalesce(b.acquired_from, date '0001-01-01'), coalesce(b.acquired_to, date '9999-12-31'), '[]')`);
  check(overlaps === 0, 'tax_config rows do not overlap on (sell-date x buy-date) per asset class');

  const [{ n: sttBad }] = await q(`
    select count(*)::int as n from charges_config
    where charge_key = 'stt_sell' and (tax_deductible or asset_class <> 'equity')`);
  check(sttBad === 0, 'STT rows are equity-only and non-deductible');

  const [{ n: goldenCharges }] = await q(`
    select count(*)::int as n from charges_config where broker_profile = 'golden'`);
  check(goldenCharges === 31, `golden fixture has 31 charge rows (6 types x 5 classes + 1 stt; got ${goldenCharges})`);

  // resolution smoke test: exactly one tax row matches each probe (sell_date, buy_date, class)
  for (const [cls, sell, buy] of [
    ['equity', '2026-02-20', '2026-01-05'],
    ['gold',   '2024-11-01', '2023-06-01'],   // 50AA transition row
    ['gold',   '2024-11-01', '2022-06-01'],   // FA2024 old-units row
    ['gold',   '2026-07-01', '2024-06-01'],   // current-regime row
    ['debt',   '2026-07-01', '2024-01-01'],
    ['intl',   '2026-07-01', '2025-01-01'],
  ]) {
    const [{ n }] = await q(`
      select count(*)::int as n from tax_config
      where asset_class = '${cls}'
        and daterange(effective_from, coalesce(effective_to, date '9999-12-31'), '[]') @> date '${sell}'
        and daterange(coalesce(acquired_from, date '0001-01-01'), coalesce(acquired_to, date '9999-12-31'), '[]') @> date '${buy}'`);
    check(n === 1, `tax_config resolves to exactly 1 row for ${cls} sell=${sell} buy=${buy} (got ${n})`);
  }

  // ================= RLS behavior =================
  console.log('\nRLS behavior:');
  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  await client.query(`insert into auth.users (id) values ('${A}'), ('${B}')`);
  // service-side fixtures (superuser stands in for service_role)
  await client.query(`
    insert into monthly_runs (id, user_id, run_month, amount_paise)
    values ('aaaaaaaa-0000-0000-0000-000000000001', '${A}', date '2026-07-01', 10000000),
           ('bbbbbbbb-0000-0000-0000-000000000001', '${B}', date '2026-07-01', 20000000);
    insert into profiles (user_id, dob, risk) values ('${B}', date '1985-01-01', 'conservative');
  `);

  const asUser = async (uid) => {
    await client.query(`reset role`);
    await client.query(`select set_config('app.uid', '${uid}', false)`);
    await client.query(`set role authenticated`);
  };

  await asUser(A);
  await client.query(`
    insert into transactions (user_id, etf_id, side, qty, price_paise, traded_on)
    values ('${A}', 1, 'buy', 10, 25000, date '2026-07-01')`);
  check(true, 'user A can insert own transaction');

  await expectError(client,
    `insert into transactions (user_id, etf_id, side, qty, price_paise, traded_on)
     values ('${B}', 1, 'buy', 5, 25000, date '2026-07-01')`,
    "user A cannot insert a transaction as user B");

  await expectError(client,
    `insert into transactions (user_id, etf_id, side, qty, price_paise, traded_on, run_id)
     values ('${A}', 1, 'buy', 5, 25000, date '2026-07-01', 'bbbbbbbb-0000-0000-0000-000000000001')`,
    "user A cannot link a lot to user B's run");

  const runsSeen = await q(`select user_id from monthly_runs`);
  check(runsSeen.length === 1 && runsSeen[0].user_id === A,
    'user A sees only their own monthly_runs');

  const upd = await client.query(`update monthly_runs set llm_cost_usd = 0 where true`);
  check(upd.rowCount === 0, 'user cannot UPDATE monthly_runs (spend-cap tamper guard) — 0 rows');

  await expectError(client,
    `insert into etf_prices (etf_id, d, close_paise) values (1, date '2026-07-01', 1)`,
    'user cannot write market data (etf_prices)');

  const updTax = await client.query(`update tax_config set ltcg_rate_pct = 0 where true`);
  check(updTax.rowCount === 0, 'user cannot UPDATE tax_config — 0 rows');

  await client.query(`
    insert into run_acknowledgements (user_id, run_id, kind)
    values ('${A}', 'aaaaaaaa-0000-0000-0000-000000000001', 'reviewed')`);
  check(true, 'user A can acknowledge own run');
  await expectError(client,
    `insert into run_acknowledgements (user_id, run_id, kind)
     values ('${A}', 'bbbbbbbb-0000-0000-0000-000000000001', 'reviewed')`,
    "user A cannot acknowledge user B's run");

  await expectError(client,
    `insert into feedback_scores (user_id, scope, ref, adj, as_of, detail)
     values ('${A}', 'etf', '1', 4, date '2026-07-01', '{}')`,
    'user cannot INSERT feedback_scores (pipeline-only)');

  // ---- profiles / fy_exemption_inputs / user_charges_overrides: own_all CRUD ----
  // B's profile row already exists (inserted as superuser above) — a real cross-tenant probe.
  await client.query(`insert into profiles (user_id, dob, risk) values ('${A}', date '1990-01-01', 'moderate')`);
  check(true, 'user A can insert own profile');
  await expectError(client,
    `insert into profiles (user_id, dob, risk) values ('${B}', date '1990-01-01', 'moderate')`,
    "user A cannot insert a second profile row as user B (also hits the primary key)");
  const updProfile = await client.query(`update profiles set risk = 'aggressive' where user_id = '${A}'`);
  check(updProfile.rowCount === 1, 'user A can update own profile');
  const updOtherProfile = await client.query(`update profiles set risk = 'aggressive' where user_id = '${B}'`);
  check(updOtherProfile.rowCount === 0, "user A cannot update user B's profile (0 rows, RLS-scoped)");
  const profilesSeen = await q(`select user_id from profiles`);
  check(profilesSeen.length === 1 && profilesSeen[0].user_id === A,
    "user A's SELECT on profiles sees only their own row, even though B's row exists");

  await client.query(`
    insert into fy_exemption_inputs (user_id, fy, used_elsewhere_paise, entered_on)
    values ('${A}', 'FY2026-27', 0, date '2026-07-01')`);
  check(true, 'user A can insert own fy_exemption_inputs row');
  await expectError(client,
    `insert into fy_exemption_inputs (user_id, fy, used_elsewhere_paise, entered_on)
     values ('${B}', 'FY2026-27', 0, date '2026-07-01')`,
    "user A cannot insert a fy_exemption_inputs row as user B");

  await client.query(`
    insert into user_charges_overrides (user_id, charge_key, asset_class, side, kind, value)
    values ('${A}', 'brokerage', 'equity', 'both', 'flat_paise', 0)`);
  check(true, 'user A can insert own user_charges_overrides row');
  await expectError(client,
    `insert into user_charges_overrides (user_id, charge_key, asset_class, side, kind, value)
     values ('${B}', 'brokerage', 'equity', 'both', 'flat_paise', 0)`,
    "user A cannot insert a user_charges_overrides row as user B");
  await client.query(`delete from user_charges_overrides where user_id = '${A}'`);
  check(true, 'user A can delete own user_charges_overrides row');

  // ---- recommendation_items: SELECT via run-ownership join ----
  await client.query(`reset role`);  // service-side fixture: bypass RLS to seed both users' rows
  await client.query(`
    insert into recommendation_items (run_id, level, theme_key, rank, score, factor_json)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'theme', 'broad_core', 1, 80, '{}'),
           ('bbbbbbbb-0000-0000-0000-000000000001', 'theme', 'broad_core', 1, 80, '{}')`);
  await asUser(A);
  const recoSeen = await q(`select run_id from recommendation_items`);
  check(recoSeen.length === 1 && recoSeen[0].run_id === 'aaaaaaaa-0000-0000-0000-000000000001',
    "user A sees only recommendation_items for their own run (B's row hidden via join policy)");
  await expectError(client,
    `insert into recommendation_items (run_id, level, theme_key, rank, score, factor_json)
     values ('aaaaaaaa-0000-0000-0000-000000000001', 'theme', 'defence', 2, 70, '{}')`,
    'user cannot INSERT recommendation_items (pipeline-only, no write policy exists)');

  // ---- reference/config/ops tables: read-only sample beyond etf_prices/tax_config ----
  const REST_ONLY_TABLES = [
    // investable explicit false: the table's own CHECK (not investable or benchmark_index
    // not null) would otherwise reject this insert before RLS is even reached, giving a
    // false-positive "blocked" reading for the wrong reason.
    { table: 'themes', cols: 'key, name, investable', vals: `'x_test', 'x', false` },
    { table: 'etfs', cols: 'isin, name, yahoo_symbol, amfi_scheme_code, underlying_index, asset_class',
      vals: `'INXTEST00001', 'x', 'X.NS', '999999', 'NIFTY 50', 'equity'` },
    // ('broad_core', 1) already exists in the seed (PK collision, not RLS) — use an unmapped pair
    { table: 'theme_etf_map', cols: 'theme_key, etf_id', vals: `'defence', 1` },
    { table: 'indices', cols: 'name', vals: `'X TEST INDEX'` },
    { table: 'nse_holidays', cols: 'd, label', vals: `date '2099-01-01', 'x'` },
    { table: 'etf_navs', cols: 'etf_id, d, nav_paise', vals: `1, date '2026-07-01', 1` },
    { table: 'index_tri', cols: 'index_name, d, value', vals: `'NIFTY 50 TRI', date '2026-07-01', 1` },
    { table: 'etf_metrics', cols: 'etf_id, as_of', vals: `1, date '2026-07-01'` },
    { table: 'charges_config', cols: 'broker_profile, charge_key, asset_class, side, kind, value, effective_from',
      vals: `'x', 'x', 'equity', 'both', 'flat_paise', 0, date '2026-07-01'` },
    { table: 'job_runs', cols: 'job', vals: `'x'` },
    { table: 'metrics_review_queue', cols: 'etf_id, as_of, missing_fields', vals: `1, date '2026-07-01', array['ter_pct']` },
    { table: 'ingest_quarantine', cols: 'job, natural_key, raw, reason', vals: `'x', 'x', '{}', 'x'` },
    { table: 'theme_research', cols: 'research_month, payload, model', vals: `date '2026-07-01', '{}', 'x'` },
  ];
  for (const { table, cols, vals } of REST_ONLY_TABLES) {
    const before = await q(`select 1 as n from ${table} limit 1`);
    check(Array.isArray(before), `user A can SELECT ${table} (read-only reference/ops table)`);
    await expectError(client, `insert into ${table} (${cols}) values (${vals})`,
      `user cannot INSERT into ${table} (service-role write only)`);
  }

  // holdings view scoping + derivation
  await asUser(B);
  const bHold = await q(`select * from holdings`);
  check(bHold.length === 0, "user B sees no holdings (A's lots invisible via security_invoker view)");
  await asUser(A);
  await client.query(`
    insert into transactions (user_id, etf_id, side, qty, price_paise, traded_on)
    values ('${A}', 1, 'sell', 4, 26000, date '2026-07-10')`);
  const aHold = await q(`select qty from holdings`);
  check(aHold.length === 1 && Number(aHold[0].qty) === 6,
    `holdings derives qty from lots (buy 10, sell 4 -> ${aHold[0]?.qty})`);

  // anon: no policies -> nothing readable
  await client.query(`reset role`);
  await client.query(`set role anon`);
  // anon now HAS table-level grants (Supabase's default) — SELECT visibility must be denied by
  // RLS itself (no policy is ever scoped to anon/public: a SELECT policy that doesn't match the
  // querying role silently filters all rows rather than erroring, which is exactly the behavior
  // under test — a bare missing GRANT would instead throw "permission denied for relation").
  const anonThemes = await q(`select * from themes limit 1`);
  check(anonThemes.length === 0, 'anon sees zero rows from themes (RLS policy scope, not a missing GRANT)');
  await expectError(client,
    `insert into transactions (user_id, etf_id, side, qty, price_paise, traded_on)
     values ('${A}', 1, 'buy', 1, 1, date '2026-07-01')`,
    'anon cannot write transactions (no with-check policy matches the anon role)');
  await client.query(`reset role`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exitCode = failures === 0 ? 0 : 1;
} finally {
  await client.end().catch(() => {});
  await epg.stop().catch(() => {});
  rmSync(dataDir, { recursive: true, force: true });
}
