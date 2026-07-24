# 04 — Tax & Charges Engine (India, post-Finance-Act-2024 regime)

Pure functions. Rates/thresholds live in `tax_config` and `charges_config` tables — BOTH
effective-dated (docs/05). Never hardcode a rate. Rules below are the FY 2025-26 / AY 2026-27
state, re-verified against Budget 2026 on 2026-07-23 (no capital-gains changes; one unrelated
change: buyback proceeds now taxed as capital gains, not dividends — out of ETF scope, noted in
§2.5). Verify again after every Union Budget. Rounding rules: docs/08 §6.

## 1. Lot accounting & config resolution
- FIFO per ISIN per demat account (matches depository practice). Lots = `transactions` rows
  (buy qty, buy price paise, buy date, charges at buy).
- Sell planner consumes lots FIFO, splits a sell across lots, classifies each slice ST/LT by
  holding period, and emits a per-slice breakdown. Sell inserts are validated against
  FIFO-available quantity on the trade date (no oversells — docs/09 §6).
- **Config resolution rule**: for a slice, pick the `tax_config` row where
  `sell_date ∈ [effective_from, effective_to]` AND `buy_date ∈ [acquired_from, acquired_to]`
  (null bounds open-ended). Rows for one asset_class must not overlap on that 2-D range —
  asserted by an engine test over the seeded config. This is how transition wrinkles (§2.2, §2.3)
  are expressed as data, never as code special-cases.
- **LTCG clock precedence**: `etfs.ltcg_months` is a nullable per-instrument OVERRIDE (used for
  intl structures, §2.4); when null, the clock comes from the resolved `tax_config.ltcg_months`.
  Rates always come from `tax_config`.
- **Charges resolution**: `charges_config` rows are effective-dated the same way (by trade date);
  per-user overrides in `user_charges_overrides` take precedence over broker-profile rows (docs/05).

## 2. Capital gains by ETF asset class (`etfs.asset_class`)

### 2.1 `equity` (equity-oriented, listed; STT-paid)
- ≤ 12 months: STCG u/s 111A @ 20% (sales on/after 23-Jul-2024).
- > 12 months: LTCG u/s 112A @ 12.5%, only on gains above the ₹1.25 lakh **aggregate annual
  exemption across all equity assets**. The engine keeps an FY exemption ledger:
  - external usage comes from `fy_exemption_inputs` (FY-scoped user assertion with entry date —
    direct-equity sales outside the app also consume the exemption; docs/05);
  - within the app, exemption is consumed **chronologically by sell date** within the FY
    (same-day ties broken by transaction `created_at`, then `id` — total FY tax is unaffected,
    per-slice attribution in golden tests is);
  - sell-planner hypotheticals apply AFTER all realized sells and the external assertion.

### 2.2 `gold` / `silver` (listed commodity ETFs)
- ≤ 12 months: STCG at slab rate (user's marginal slab is a profile setting).
- > 12 months: LTCG @ 12.5% without indexation; the ₹1.25L exemption does NOT apply.
- Transition wrinkle: units bought Apr-2023→Mar-2025 sold in the interim had slab treatment —
  expressed as a `tax_config` row with `acquired_from/acquired_to` set (§1), not code.

### 2.3 `debt`
- Bought on/after 1-Apr-2023: slab rate regardless of holding period (no LTCG, no indexation) —
  the buy-date condition is an `acquired_from` bound in config.

### 2.4 `intl` (international FoF/ETF)
- Post-Jul-2024 rules differ for listed ETFs vs FoFs and have a 24-month LTCG clock for unlisted/FoF
  structures; store the clock in `etfs.ltcg_months` per instrument (override, §1). Default
  listed intl ETF: 12m / 12.5%; FoF: 24m / 12.5%. `VERIFY-AT-SEED` per instrument — the Phase 0
  verifier could not re-derive these clocks from a primary source.

### 2.5 Common
- Cess 4% on tax; surcharge per slab config (owner-level setting).
- Dividends (IDCW): slab rate; record as income rows, not gains. (Budget 2026 buyback-as-capital-
  gains change affects direct stocks only; noted here in case stocks ever enter scope.)
- Loss set-off: STCL offsets STCG+LTCG; LTCL offsets LTCG only; 8-year carry-forward if ITR filed on
  time. Engine reports set-off suggestions in the FY report (display-only in v1).

## 3. Charges stack (`charges_config`, per-broker profile; defaults ≈ discount broker, verify against owner's broker)
| Charge | Buy | Sell | tax_deductible | Note |
|---|---|---|---|---|
| Brokerage | ₹0 (equity delivery) | ₹0 | yes | config per broker |
| STT (equity ETF) | — | 0.001% (delivery; intraday would be 0.025%, out of scope) | **no** | ETFs ≠ stocks (stocks 0.1% both sides); gold/silver/debt ETFs: no STT |
| Exchange txn (NSE) | ~0.00297% | ~0.00297% | yes | |
| SEBI fee | 0.0001% | 0.0001% | yes | |
| Stamp duty | 0.015% | — | yes | buy side only |
| GST 18% | on brokerage+txn+SEBI | same | yes | composition convention: docs/05 `charges_config` comment |
| DP charge | — | flat per ISIN per day (fixture ₹15.93 incl GST) | yes | flat, hurts small sells — engine surfaces this |
| Exit load | none for ETFs | — | — | FoFs DO have exit loads: `exit_load_pct` + `exit_load_days` per instrument |

**Cost basis & deductibility (s.48 proviso)**: for 111A/112A computations STT is deductible on
NEITHER side; every other charge is includible (buy) / deductible (sell). Each `charges_config`
row carries `tax_deductible` (docs/05).
```
effective_cost      = qty·buy_price + Σ deductible buy charges
net_consideration   = qty·sell_price − Σ deductible sell charges
taxable_gain        = net_consideration − effective_cost      (per FIFO slice, apportioned per docs/08 §6.4)
tax                 = max(0, taxable_gain) × rate × 1.04      (loss slices pay 0; loss recorded for set-off — docs/08 §6.5)
netProceeds(sell)   = gross − ALL charges (incl. STT) − tax   (cash reality, regardless of deductibility)
```
Tax math always **recomputes charges from the resolved config** (charges/tax config by trade
date, §1); `transactions.charges_paise` is informational/reconciliation-only — it cannot be
split into deductible vs non-deductible after the fact.

## 4. Worked examples (golden tests — engine must reproduce to the paisa)

### §4.0 Golden fixture (pinned; all E-tests use exactly these values)
`charges_config` (broker_profile `golden`, equity, delivery): brokerage 0; stt_sell 0.001%
(tax_deductible=false); txn 0.00297% both sides; sebi 0.0001% both sides; stamp_buy 0.015%;
gst 18% on (brokerage+txn+sebi); dp_sell_flat 1593 paise (incl. its GST). Gold/silver/debt: same
minus STT. `tax_config`: equity STCG 20% flat / LTCG 12m 12.5% / exemption 12,500,000 paise;
gold slab STCG / LTCG 12m 12.5% / exemption 0; cess 4%. Rounding per docs/08 §6.

**E1** Buy 100 units equity ETF @ ₹250 on 05-Jan-2026; sell 100 @ ₹310 on 20-Feb-2026 (46 days, STCG).
```
BUY  consideration 2,500,000 p; txn 74.25→74; sebi 2.5→3; stamp 375; gst 18%×(74.25+2.5)=13.815→14
     buy charges 466 p; effective_cost 2,500,466 p
SELL consideration 3,100,000 p; stt 31 (non-deductible); txn 92.07→92; sebi 3.1→3;
     gst 18%×(92.07+3.1)=17.1306→17; dp 1593; sell charges 1,736 p (deductible 1,705 p)
taxable_gain = (3,100,000 − 1,705) − 2,500,466 = 597,829 p (₹5,978.29)
tax+cess     = 597,829 × 0.20 × 1.04 = 124,348.432 → 124,348 p (₹1,243.48)
netProceeds  = 3,100,000 − 1,736 − 124,348 = 2,973,916 p (₹29,739.16)
```
(The earlier draft's "gain ₹6,000 → tax ₹1,248" assumed a zero-charge fixture; superseded by the above.)

**E2** Same buy; sell 100 @ ₹310 on 10-Feb-2027 (>12m), only equity sale of FY, no external exemption
usage. Same charge arithmetic as E1 ⇒ taxable_gain 597,829 p < 12,500,000 p exemption → LTCG tax 0;
exemption ledger records 597,829 p consumed; netProceeds = 3,100,000 − 1,736 = 3,098,264 p (₹30,982.64).

**E3** Gold ETF, taxable gain (already charge-adjusted) 4,000,000 p in 8 months, slab 30% →
tax+cess = 4,000,000 × 0.30 × 1.04 = 1,248,000 p (₹12,480.00); no ₹1.25L relief, no STT in the
charges stack (gold).

**E4** Sell 150 units where lot1=100 (14m old) + lot2=100 (3m old) → FIFO: 100 LT + 50 ST, two
slices, two regimes, ONE charges pass on the single market sell, apportioned to slices pro-rata by
consideration with largest-remainder paise fixing (docs/08 §6.4): slice charges sum exactly to the
order's charges.

**E5** LAG rotation proposal on a 10.5-month-old lot (q units, current price P0, LTCG date D):
```
net_now       = q·P0 − charges_sell(q·P0) − tax_STCG(gain(P0))
net_later(P)  = q·P  − charges_sell(q·P)  − tax_LTCG(gain(P))     // valid for sells on/after D
breakeven P*  solves net_later(P*) = net_now  — piecewise-linear in P (one kink where remaining
               LTCG exemption is exhausted; tax floored at 0 per docs/08 §6.5). P* is solved on
               the UNROUNDED linear forms and reported as an approximation to the paisa (per-charge
               rounding makes the true net a step function; empirically the gap between the
               unrounded-linear and exact-bigint net at P* is up to ~2 paisa on typical sell
               sizes — several independently-rounded percentage charge lines compound, not a
               single sub-paisa step — immaterial for an advisory breakeven, not used for any
               booked tax figure).
Report: tax-if-now, tax-if-after-D, P*, and drop d* = (P0 − P*)/P0 (the price fall that would
equalize; "hold to LTCG date" advice per docs/03 §5 unless drawdown vs peers > 10%).
```
E2–E5 expected outputs are derived from the same §4.0 fixture and docs/08 §6 rounding; the full
expected-value tables (every charge line, per slice) are frozen as golden JSON fixtures at build
step 3 from an independent hand calculation, reviewed against this doc before the engine is run
against them.
