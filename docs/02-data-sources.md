# 02 — Data Sources (endpoints, cadence, fallbacks)

Principle: free, EOD, cache-everything-in-Postgres. The app never hits an external source at
page-render time; the frontend reads only Supabase tables. All ingesters enforce the integrity
gates in docs/09 §5 (sanity bounds, quarantine, strict parsing). Live-verified 2026-07-23 by the
Phase 0 data-verifier; items it could not confirm are marked `VERIFY-AT-SEED`.

## 1. ETF market prices & volumes — Yahoo Finance (`.NS` symbols)
- What: daily OHLCV + last close for exchange-traded price (what you actually pay), average daily
  traded value (liquidity input).
- How: same unofficial chart endpoint already used in Ledger — reuse that client (backoff,
  UA rotation, IST session handling). Symbols seeded in `etfs.yahoo_symbol` (e.g. `NIFTYBEES.NS`,
  `MODEFENCE.NS`, `GOLDBEES.NS` — all three verified live; note Bharat 22 = `ICICIB22.NS`).
- Cadence: nightly 18:30 IST (`ingest-prices`; authoritative cron catalog: docs/10 §2).
- Fallback: NSE bhavcopy CSV (EOD, free) parsed by ISIN. **Verified live 2026-07-23** (build
  step 2): the modern UDiFF format at
  `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_DDMMYYYY_F_0000.csv.zip`
  (zipped CSV; unzip via a small library, e.g. `npm:fflate`) is ISIN-keyed
  (`ISIN,TckrSymb,...,ClsPric,...,TtlTradgVol,TtlTrfVal,...`) and confirmed to match our seed
  ISINs exactly (e.g. `INF204KB14I2`=NIFTYBEES, `INF247L01DJ0`=MODEFENCE). `TtlTrfVal` is the
  day's true turnover in rupees — more accurate than the close×volume approximation the
  Yahoo-based primary path must use. Keep the parser behind the same interface (both paths
  produce the same row shape for `etf_prices`).
- Note (from Ledger experience): symbol resolution drifts; store `yahoo_symbol` explicitly per ETF,
  never resolve by search at runtime.

## 2. NAV history — mfapi.in + AMFI
- mfapi.in: free REST, full historical NAV per AMFI scheme code: `https://api.mfapi.in/mf/{scheme_code}`
  (verified live). ETFs are covered (they are MF schemes). Store `amfi_scheme_code` per ETF.
  **Seeding caveat (verified)**: AMC renamings leave legacy duplicate scheme codes (e.g. Gold BeES
  appears under 105085/115744/140088 — current is 140088); seed the code whose scheme name matches
  the current AMC name, never the first search hit.
- AMFI daily master: `https://www.amfiindia.com/spages/NAVAll.txt` — **now 302-redirects to
  `https://portal.amfiindia.com/spages/NAVAll.txt`** (verified); ingester must follow redirects or
  hit the portal URL. Plain text, semicolon-delimited, all schemes daily; use for daily upsert +
  integrity check of mfapi.
- Bulk backfill: captn3m0/historical-mf-data (GitHub releases, SQLite of all AMFI history —
  verified maintained, release v0.0.20260723). One-time seed instead of hammering mfapi; **pin the
  release + SHA-256 and sample-validate against AMFI before accepting** (docs/09 §5).
- Why NAV *and* price: `premium_discount = (price − nav)/nav`. Thin thematic ETFs trade at
  premiums; the engine blocks buys when premium > 1% (docs/03 §3 gate G6).

## 3. Benchmark indices — TRI
- All performance comparisons use **Total Return Index**, not price index (dividends matter; using
  the price index flatters the ETF). Series bases per computation: docs/08 §3. Themes without a
  TRI (gold, silver, NASDAQ-100) use the flagged proxy series defined in docs/03 §6.
- Source: niftyindices.com historical data endpoints (free, EOD) for Nifty 50 TRI, Nifty India
  Defence TRI, Nifty India Manufacturing TRI, Nifty Infrastructure TRI, Nifty CPSE TRI, Nifty IT
  TRI, etc. **Status 2026-07-23: the site responds but the underlying POST endpoints
  (`Backpage.aspx/...`) currently return errors to non-browser payloads — exact contract
  `VERIFY-AT-SEED`.** Build the ingester tolerant of schema drift, cache aggressively, and treat
  the **manual CSV upload path in Settings as an expected first-class path, not a last resort**.
- Cadence: nightly (docs/10 §2).

## 4. ETF quality metrics — AUM, TER, tracking error, tracking difference
- Regulatory basis: SEBI mandates passive funds disclose tracking error (1y rolling) daily and
  tracking difference monthly (1/3/5/10y tenures) on AMC websites and AMFI; equity ETF TE is capped
  at 2%. So the data exists and is public — but there is **no single clean API**.
- v1 approach (honest about effort): `etf_metrics` monthly snapshot table populated by
  `refresh-metrics`, a **manual-assisted** flow: the Edge Function pulls what it can (AMFI data pages,
  AMC factsheet URLs stored per ETF), and anything it can't parse lands in a review queue where the
  owner pastes numbers from the factsheet. ~20–40 ETFs in universe → 15 min/month worst case.
  Metrics older than 45 days gate the ETF out (`stale_metrics`, docs/10 §4) — stale data is never
  silently used.
- Do NOT scrape Value Research / Morningstar / Tickertape programmatically (ToS risk); they're for
  manual cross-checking only.
- Fields per ETF per month: `aum_cr`, `ter_pct`, `tracking_error_1y`, `tracking_diff_1y/_3y/_5y`,
  `adtv_paise` (computed from price ingester), `premium_discount_30d` (computed).

## 5. Theme research — Anthropic API (Sonnet + web_search tool)
- Monthly, one call chain: "current Indian macro/policy tailwinds relevant to listed thematic
  indices" → structured JSON: candidate themes, rationale, cited sources, suggested horizon.
- Output is advisory input to the deterministic gate only (CLAUDE.md invariant). Cached in
  `theme_research` **keyed by month, not by run** — one research pass per month serves every user
  (docs/05, docs/06 §3); never re-run within the month unless forced (forced re-runs count against
  the global spend cap, docs/10 §7).

## 6. Universe seed & maintenance
- `etfs` table seeded from the NSE ETF list — **verified: available as a CSV download on
  nseindia.com and as JSON at `/api/etf` (requires a cookie-priming GET with browser UA; the JSON
  includes live price and NAV per ETF)** — filtered to: equity broad, equity thematic/sector, gold,
  silver. Debt ETFs included only for the conservative core option.
- International exposure ("Let research decide" per owner): Motilal Oswal NASDAQ 100 ETF (MON100)
  and similar are in-universe but flagged `intl = true`. Two hard warnings the engine enforces:
  (a) many international FoFs/ETFs periodically suspend fresh subscriptions when RBI overseas
  investment limits are hit — creation halts make listed price detach badly from NAV, so gate G6
  (premium/discount) is the practical guard. **Live evidence (Jul-2026): MON100 trades at ~20%
  premium to NAV — G6 blocks it; this is the expected steady state for capped intl ETFs, not an
  anomaly**; (b) different tax class (docs/04 §2.4).
- Themes with **no Indian listing** (water, rare earth — re-verified Jul-2026): keep in `themes`
  with `investable=false` and a `proxy_note` (e.g., rare earth → closest proxies are metals/mining
  or global FoF exposure; water → infra/utilities proxy). The UI shows "researched but not
  investable in India" so the theme list stays honest instead of silently narrowing.

## 7. Cadence summary (informative — the authoritative cron catalog with UTC expressions,
first-trading-day logic, and the pipeline driver is docs/10 §2–3)
| Job | Schedule (IST) | Function |
|---|---|---|
| Prices + volumes | Nightly 18:30 (Mon–Fri) | ingest-prices |
| NAVs | Nightly 22:30 (AMFI publishes late evening) | ingest-nav |
| TRI | Nightly 23:00 | ingest-tri |
| Metrics snapshot | Monthly, last Saturday 10:00 | refresh-metrics (+ manual queue) |
| Monthly run | 1st trading day **23:30** (after prices+NAV+TRI land) | monthly-run |
| Pipeline driver | every 10 min | run-driver |
| Backup export | Nightly 03:00 | export-backup |

All jobs idempotent (upsert on natural keys), logged to `job_runs` with row counts; failures and
quarantined rows surface per docs/10 §6.

## 8. Licensing posture (personal tool vs product)
Today (personal use): the Yahoo chart endpoint (unofficial), mfapi.in (community API, no SLA/license)
and niftyindices CSVs (semi-official) are tolerated-use sources. AMFI NAVAll is genuinely public.
**Before productization**: these are ToS/business-continuity risks — commercial use of Yahoo's
endpoint is against its ToS, and NSE requires paid licensing for commercial redistribution of index
data. Budget for licensed feeds (NSE datafeed / index license or a licensed vendor) as part of the
product-phase gate; tracked in docs/07 open items.
