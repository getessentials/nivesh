// Generates supabase/migrations/20260723000004_seed_etf_universe.sql and
// 20260723000005_seed_nse_holidays.sql from supabase/seed-data/universe.json
// (produced by the live seed-data verification pass — see docs/02).
// Deterministic: same JSON in, same SQL out. Excluded (unverified) ETFs are listed
// in a comment block, never guessed.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'supabase/seed-data/universe.json'), 'utf8'));

// Migrations are append-only history once applied to a real Supabase project (tracked by
// filename in supabase_migrations.schema_migrations). This script must NEVER silently rewrite
// an already-generated seed migration in place — that causes migration-history drift on the
// next deploy (docs/10 §1 "re-seed annually" implies re-running this script months later,
// against a DB that already applied the original file). If the target already exists with
// different content, emit a NEW timestamped upsert migration instead and leave history alone.
function writeSeedMigration(fixedRelPath, bootstrapSql, upsertSql, deltaBaseName) {
  const fixedPath = join(root, fixedRelPath);
  if (!existsSync(fixedPath)) {
    writeFileSync(fixedPath, bootstrapSql);
    console.log(`  wrote ${fixedRelPath} (new)`);
    return;
  }
  const existing = readFileSync(fixedPath, 'utf8');
  if (existing === bootstrapSql) {
    console.log(`  ${fixedRelPath} unchanged, left as-is`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const deltaPath = join(root, 'supabase/migrations', `${stamp}_${deltaBaseName}.sql`);
  writeFileSync(deltaPath, upsertSql);
  console.log(`  ${fixedRelPath} already exists and differs — did NOT overwrite it.`);
  console.log(`  wrote a new upsert delta migration instead: supabase/migrations/${stamp}_${deltaBaseName}.sql`);
  console.log(`  review the delta before applying; it will not be applied automatically.`);
}

const esc = (s) => s == null ? null : String(s).replace(/'/g, "''");
const lit = (s) => s == null ? 'null' : `'${esc(s)}'`;

const THEME_KEYS = new Set(['broad_core','defence','manufacturing','infrastructure','psu_value',
  'it_digital','ai_global_tech','gold','silver','consumption','metals_commodities','energy','debt_liquid']);
const ASSET_CLASSES = new Set(['equity','gold','silver','debt','intl']);

// nav_proxy series per theme: index name + which theme it benchmarks
const NAV_PROXY = {
  gold:           { index: 'GOLD ETF NAV PROXY',    themeName: 'Gold' },
  silver:         { index: 'SILVER ETF NAV PROXY',  themeName: 'Silver' },
  ai_global_tech: { index: 'NASDAQ 100 NAV PROXY',  themeName: 'AI / global tech' },
  debt_liquid:    { index: 'LIQUID ETF NAV PROXY',  themeName: 'Liquid / overnight debt' },
};

const verified = [];
const excluded = [];
for (const e of data.etfs) {
  const problems = [];
  if (!THEME_KEYS.has(e.theme_key)) problems.push(`unknown theme_key ${e.theme_key}`);
  if (!ASSET_CLASSES.has(e.asset_class)) problems.push(`bad asset_class ${e.asset_class}`);
  if (!/^IN[A-Z0-9]{10}$/.test(e.isin ?? '')) problems.push(`bad/missing ISIN ${e.isin}`);
  if (!e.yahoo_symbol || e.status === 'VERIFY-AT-SEED') problems.push('yahoo symbol unverified');
  if (!e.amfi_scheme_code) problems.push('missing AMFI scheme code');
  if (!e.underlying_index) problems.push('missing underlying index');
  if (problems.length) excluded.push({ e, problems });
  else verified.push(e);
}

const isinSeen = new Map();
for (const e of verified) {
  if (isinSeen.has(e.isin)) throw new Error(`duplicate ISIN ${e.isin}: ${e.name} / ${isinSeen.get(e.isin)}`);
  isinSeen.set(e.isin, e.name);
}

// underlying indices present in the fixed seed (migration 0002)
const KNOWN_UNDERLYING = new Set(['NIFTY 50','NIFTY NEXT 50','BSE SENSEX','NIFTY INDIA DEFENCE',
  'NIFTY INDIA MANUFACTURING','NIFTY INFRASTRUCTURE','BSE INDIA INFRASTRUCTURE','NIFTY CPSE',
  'BSE BHARAT 22','NIFTY PSU BANK','NIFTY IT','NIFTY INDIA CONSUMPTION','NIFTY METAL',
  'NIFTY ENERGY','NASDAQ 100','DOMESTIC GOLD','DOMESTIC SILVER','NIFTY 1D RATE']);
const newUnderlying = [...new Set(verified.map(e => e.underlying_index))]
  .filter(u => !KNOWN_UNDERLYING.has(u)).sort();

const THEME_META = {
  gold:           { name: 'Gold',                  investable: true },
  silver:         { name: 'Silver',                investable: true },
  ai_global_tech: { name: 'AI / global tech',      investable: true,
                    note: 'Proxy exposure via NASDAQ 100 (intl tax + RBI-cap G6 caveats); no pure Indian AI index ETF' },
  debt_liquid:    { name: 'Liquid / overnight debt', investable: true,
                    note: 'Exists so the conservative non-equity sleeve has a scored cohort (docs/03 §1)' },
};

// mode: 'bootstrap' (plain insert, first-generation only) | 'upsert' (safe to re-apply against
// an already-seeded DB — used only for the delta migration path, never for the fixed files).
function buildUniverseSql(mode) {
  const onConflict = mode === 'upsert';
  let sql = `-- Seed: verified ETF universe (generated by scripts/generate-universe-seed.mjs from
-- supabase/seed-data/universe.json, verified ${esc(data.verified_at)} against AMFI NAVAll +
-- Yahoo chart API). ${onConflict ? 'Upsert delta — safe to re-apply.' : 'Do not hand-edit; regenerate.'}
`;
  if (excluded.length) {
    sql += `--\n-- EXCLUDED (VERIFY-AT-SEED, not guessed):\n`;
    for (const { e, problems } of excluded)
      sql += `--   ${esc(e.name) ?? esc(e.theme_key)}: ${esc(problems.join(', '))}\n`;
  }
  sql += '\n';

  if (newUnderlying.length) {
    sql += `insert into indices (name, tri_source, notes) values\n` +
      newUnderlying.map(u => `  (${lit(u)}, 'none', 'underlying only (from universe verification)')`).join(',\n') +
      '\n  on conflict (name) do nothing;\n\n';
  }

  sql += `insert into etfs (isin, name, yahoo_symbol, amfi_scheme_code, underlying_index,
                  asset_class, intl, ltcg_months, listed_on) values\n` +
    verified.map(e =>
      `  (${lit(e.isin)}, ${lit(e.name)}, ${lit(e.yahoo_symbol)}, ${lit(e.amfi_scheme_code)}, ` +
      `${lit(e.underlying_index)}, ${lit(e.asset_class)}, ${e.asset_class === 'intl'}, ` +
      `${e.ltcg_months ?? 'null'}, ${lit(e.listed_on)})`).join(',\n') +
    (onConflict
      ? `\n  on conflict (isin) do update set name = excluded.name, yahoo_symbol = excluded.yahoo_symbol,
    amfi_scheme_code = excluded.amfi_scheme_code, underlying_index = excluded.underlying_index,
    asset_class = excluded.asset_class, intl = excluded.intl, ltcg_months = excluded.ltcg_months,
    listed_on = excluded.listed_on;\n\n`
      : ';\n\n');

  // nav_proxy indices + the themes benchmarked on them MUST land before theme_etf_map, which
  // references these theme_key values.
  sql += `-- nav_proxy benchmark series: pinned to one verified ETF each (docs/03 §6; owner may
-- re-pin via docs/07 §13 item 13 before first ingestion)\n`;
  const proxyThemeRows = [];
  for (const [theme, cfg] of Object.entries(NAV_PROXY)) {
    const pick = verified.find(e => e.theme_key === theme && e.proxy_pick)
              ?? verified.find(e => e.theme_key === theme);
    if (!pick) { sql += `-- WARNING: no verified ETF for theme ${theme}; nav_proxy row skipped\n`; continue; }
    sql += `insert into indices (name, tri_source, notes, proxy_etf_id)\n` +
      `select ${lit(cfg.index)}, 'nav_proxy', ${lit('NAV series of ' + pick.name)}, id from etfs where isin = ${lit(pick.isin)}` +
      (onConflict
        ? `\non conflict (name) do update set notes = excluded.notes, proxy_etf_id = excluded.proxy_etf_id;\n`
        : ';\n');
    proxyThemeRows.push({ theme, cfg });
  }
  sql += '\n';

  sql += `insert into themes (key, name, investable, proxy_note, benchmark_index) values\n` +
    proxyThemeRows.map(({ theme, cfg }) => {
      const m = THEME_META[theme];
      return `  (${lit(theme)}, ${lit(m.name)}, ${m.investable}, ${lit(m.note ?? null)}, ${lit(cfg.index)})`;
    }).join(',\n') +
    (onConflict
      ? `\n  on conflict (key) do update set name = excluded.name, investable = excluded.investable,
    proxy_note = excluded.proxy_note, benchmark_index = excluded.benchmark_index;\n\n`
      : ';\n\n');

  sql += `insert into theme_etf_map (theme_key, etf_id)\nselect v.theme_key, e.id from (values\n` +
    verified.map(e => `  (${lit(e.theme_key)}, ${lit(e.isin)})`).join(',\n') +
    `\n) as v(theme_key, isin) join etfs e on e.isin = v.isin` +
    (onConflict ? '\non conflict (theme_key, etf_id) do nothing;\n\n' : ';\n\n');

  return sql;
}

writeSeedMigration(
  'supabase/migrations/20260723000004_seed_etf_universe.sql',
  buildUniverseSql('bootstrap'),
  buildUniverseSql('upsert'),
  'update_etf_universe'
);

// holidays
const hol = data.nse_holidays_2026 ?? [];
function buildHolidaySql(mode) {
  return `-- Seed: NSE trading holidays 2026 (docs/10 §1; re-seed annually — owner task).
-- Source: ${esc((data.notes ?? []).find(n => /holiday/i.test(n)) ?? 'see universe.json notes')}${
    mode === 'upsert' ? '\n-- Upsert delta — safe to re-apply.' : ''}
insert into nse_holidays (d, label) values
` + hol.map(h => `  ('${h.d}', ${lit(h.label)})`).join(',\n') +
    (mode === 'upsert' ? '\non conflict (d) do update set label = excluded.label;\n' : ';\n');
}
writeSeedMigration(
  'supabase/migrations/20260723000005_seed_nse_holidays.sql',
  buildHolidaySql('bootstrap'),
  buildHolidaySql('upsert'),
  'update_nse_holidays'
);

console.log(`universe: ${verified.length} ETFs seeded, ${excluded.length} excluded (VERIFY-AT-SEED)`);
console.log(`holidays: ${hol.length} days`);
for (const { e, problems } of excluded) console.log(`  excluded: ${e.name ?? e.theme_key} — ${problems.join(', ')}`);
