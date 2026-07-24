# 03 — Scoring, Allocation & Feedback Engine (deterministic core)

Pure TypeScript in `packages/engine/`. No I/O, no Date.now() (clock injected), every public
function unit-tested. The LLM never touches anything in this file's scope.
**All percentiles, windows, return bases, rounding, and the float↔paise boundary follow
docs/08-computation-conventions.md.** Floats are allowed in scoring/weights; every ₹ figure
crosses to integer paise exactly once (docs/08 §5); unit/tax math is integer-only after that.

## 1. Profile mapping
```
equity_pct(age, risk) = clamp(115 - age + riskAdj, 40, 90)   // riskAdj: cons -10, mod 0, aggr +10
themeCount(risk)      = cons: 1–2, mod: 2–4, aggr: 3–5       // engine picks max allowed by supply
coreSatellite(risk)   = cons 80/20, mod 65/35, aggr 50/50    // split of the EQUITY sleeve
```
Sleeve math (explicit; X_spendable = amount_paise + carry_in_paise, docs/05):
```
equity_sleeve   = equity_pct% × X_spendable
core            = coreShare      × equity_sleeve
satellite       = (1−coreShare)  × equity_sleeve
non_equity      = (100−equity_pct)% × X_spendable   → gold ETF (default) or debt ETF (conservative toggle; profiles.non_equity_sleeve)
```
The non-equity sleeve buys the best-S_etf eligible ETF of the `gold` or `debt_liquid` theme
(§6) respectively — same gates, same scoring, deterministic. Its recommendation_items row carries
that theme_key (core rows carry `broad_core`) so every ETF-level row has a non-NULL theme_key.
**Core index is chosen deterministically, not scored across indices** (an index choice is a theme-layer
decision; scoring wrappers across Nifty 50/Next 50/Sensex would smuggle in an index bet — docs/07 §3).
Default core index = `profiles.core_index` (ships as NIFTY 50). The core ETF = best S_etf among
wrappers of THAT index only.

Cross-sleeve dedup: the one-per-index rule (§3.3) applies across the whole plan. If the gold THEME
is selected while the non-equity sleeve is also gold, the same (single, best-scored) gold ETF takes
both allocations, shown as one merged plan line with the two sleeve contributions itemized.

## 2. Theme layer

### 2.1 Candidate generation (LLM, advisory only)
Sonnet + web search returns ≤10 candidates: `{theme_key, thesis, policy_tailwind_score 0–5, sources[]}`.
Zod-validated; `theme_key` must match the seeded `themes` table (LLM cannot invent themes).
Rendering/containment rules: docs/09 §8.

### 2.2 Investability gate (hard, deterministic)
A theme is investable iff ≥1 ETF in `theme_etf_map` passes ALL ETF eligibility gates (§3.1).
Non-investable themes are reported with proxy notes but cannot rank.

### 2.3 Theme score (0–100)
```
S_theme = 25·policy    // LLM's 0–5 tailwind /5, capped — the ONLY LLM-sourced input (≤25%)
        + 25·momentum  // theme benchmark series 6m return, percentile vs investable themes (docs/08 §1–2)
        + 20·trend     // 12m return percentile
        + 15·breadth   // 0.5·pct(eligible_etf_count) + 0.5·pct(log10(total_aum_cr))  (docs/08 §7)
        + 15·diversify // 1 − |corr(theme series, portfolio NAV daily returns)|; construction in docs/08 §4
```
**Scoring cohort** (fixed, identical every month regardless of the LLM candidate list): all
`investable=true` themes EXCLUDING `broad_core` (the core is chosen outside scoring, §1 —
broad_core never ranks as a satellite). `gold`/`silver`/`debt_liquid` MAY rank as satellites;
cross-sleeve dedup per §1 merges positions if the non-equity sleeve holds the same ETF.
LLM candidates simply supply the `policy` factor for the themes they name; non-named investable
themes score with `policy = 2.5` (neutral).
Missing/short benchmark series (<12m usable): momentum and trend components fall back to neutral
0.5 with an `"insufficient_history"` tag (docs/08 §2). Every investable theme MUST have a
benchmark series (§6; schema-enforced in docs/05; `nav_proxy` series = the NAV of the ETF pinned
in `indices.proxy_etf_id` — pinned at seed, never "largest this month").

### 2.4 Feedback adjustment (§5) is added (`S_theme_final = S_theme + theme_adj`), themes sorted by
S_theme_final; top N selected; each gets a numbered rank and the factor table handed to Haiku for
the "why #1 over #2" narrative.

### 2.5 Fallback set
If LLM stage fails twice (or the monthly spend cap is hit — docs/10 §7): default candidates = all
investable themes, `policy = 2.5` flat. The run proceeds — the pipeline never blocks on the LLM.

## 3. ETF layer (within each selected theme)

### 3.1 Eligibility gates (hard filters — fail any ⇒ excluded, with reason logged)
- G1 AUM ≥ ₹100 cr (broad) / ≥ ₹50 cr (thematic, with UI warning chip)
- G2 Listed ≥ 12 months (else excluded; 12–36 months allowed but short-history handling in §3.2).
  NULL `listed_on` ⇒ excluded, reason `missing_listing_date`
- G3 ADTV (30d avg daily traded value; "30d" per docs/08 §2 = 30 trading days, ≥20 obs) ≥ ₹25 lakh
- G4 tracking_error_1y ≤ 2% (SEBI cap); AND ≤ 2× median TE of same-index peers **only when the
  same-index cohort has ≥ 3 members** (median of 1–2 is degenerate — absolute cap still applies)
- G5 TER ≤ 1.0%
- G6 30d avg |premium/discount| ≤ 1.0% (30 trading days, ≥20 obs with price+NAV — docs/08 §2)
  AND plan-day premium ≤ 1.0% (as-of dates per docs/10 §2)
- G7 Metrics freshness: latest etf_metrics.as_of ≤ 45 days and gate fields non-NULL, else excluded
  with reason `stale_metrics` (docs/10 §4)

Gates always precede stickiness (§5): a gated-out incumbent is **held, not added to** — it cannot
receive new allocation regardless of feedback status.

### 3.2 ETF score (0–100), computed vs peers on the SAME underlying index where possible,
else vs theme cohort (cohort <4 ⇒ full-universe fallback, docs/08 §1):
```
S_etf = 25·trackingQuality  // fidelity: −|TD| percentile — |TD| closest to zero is best, positive
                            //   TD not rewarded; 1y/3y blend 0.6/0.4 when TD_3y exists (docs/08 §1)
      + 20·liquidity        // ADTV percentile (log-scaled)
      + 15·cost             // −TER percentile
      + 10·scale            // log(AUM) percentile
      + 15·peerReturn       // 3y NAV CAGR percentile vs cohort; if history <3y use max common window
      + 15·momentum         // 6m NAV total return percentile vs cohort
shortHistoryPenalty: if history <3y, subtract 5 points from the summed S_etf (floor 0) + "young fund" chip.
S_etf_final = clamp(S_etf, 0, 100) + etf_adj (decayed, §5; used for ranking and stickiness).
```
Rationale for weights: for a passive product, replication quality + cost of ownership (tracking, TER,
spread) is what you can actually control; past absolute return mostly reflects the index, so it gets
peer-RELATIVE treatment only (this is the honest answer to "top ETF which gave nice profit in past" —
you rank the wrapper by how faithfully+cheaply it delivers the index, and rank the index via the theme layer).
Ranked list capped at 5, min 1; ties broken by lower TER, then higher AUM, then lower etf_id.

### 3.3 One-per-index rule
Never allocate to two ETFs tracking the same index in the same plan (they're duplicates); keep the
higher-scored one, show the loser as "runner-up — why it lost" (this directly gives the owner's
"why this over that" comparison for free). Applies across sleeves (§1 cross-sleeve dedup).
When dedup removes one of a theme's picks, the 70/30 within-theme split (§4) re-applies over the
post-dedup ranked list (falling to 100% if one pick remains).

## 4. Allocation of X (integer units, greedy remainder)
```
Input: X_spendable = amount_paise + carry_in_paise; picks with target weights; last close prices.
1. Split X_spendable → core / satellite / non-equity per §1.
2. Satellite theme weights: w_i = exp(S_theme_final_i/20) / Σ exp(S_theme_final_j/20), then bounds:
     N=1: theme gets 100% (bounds inapplicable)
     N=2: bounds [35%, 65%]
     N≥3: bounds [10%, 50%]
   (Feasible for all allowed N: N·lo ≤ 1 ≤ N·hi.)
   Bounded renormalization (deterministic, two phases — a single mixed pass can freeze
   everything with Σw ≠ 1):
     Phase A (upper bounds): while any unfrozen w_i > hi: clip those to hi, freeze them,
       renormalize the unfrozen weights over mass 1 − Σ(frozen).
     Phase B (lower bounds): while any unfrozen w_i < lo: raise those to lo, freeze them,
       renormalize the remaining unfrozen weights over the remaining mass — re-checking that no
       unfrozen weight now exceeds hi (if one does, clip/freeze it at hi and continue).
     Terminates in ≤ N freezes; the phase split guarantees Σw = 1 (e.g. scores {90,30,30}, N=3:
     phase A freezes 0.50, phase B renormalizes the rest to {0.25, 0.25}).
   Within theme: 1 ETF → 100%; 2+ → 70/30 to top-2 by S_etf_final
   (thematic depth beyond 2 adds churn, not diversification).
3. Per-pick paise: alloc_paise[i] = floor(weight_i × sleeve_paise) (docs/08 §5); flooring
   shortfall joins the remainder pool. Units: units[i] = floor(alloc_paise[i] / price_paise[i]).
4. Remainder pass: pool := all leftover paise.
   Per-pick cap: cap_p = the pick's TARGET weight (weight_target) as a % of X_spendable — for
   satellite picks that is (satellite_sleeve / X_spendable) × theme_weight × within-theme split
   (theme_weight is a fraction of the SATELLITE SLEEVE, not of X); core and non-equity picks are
   capped at their sleeve share. Tolerance: +2 PERCENTAGE POINTS (absolute, not relative).
   while ∃ pick p with price_paise[p] ≤ pool AND (actual weight of p incl. this unit) ≤ cap_p + 2pp:
     buy 1 unit of the eligible pick with highest S_etf_final
     (ties: higher S_etf_final → lower TER → lower etf_id; weights measured against X_spendable)
   Loop exits when NO pick is both affordable and under cap — this can leave pool ≥ the cheapest
   pick's price when all picks are cap-bound; that is reported as a "cap-bound residual".
5. residual_paise = pool; persisted on monthly_runs; reported as "carry to next month".
   carry_in_paise of a new run = residual_paise of the most recent `done`, non-superseded run
   with an earlier (run_month, seq) — failed/superseded runs are SKIPPED, so residual passes
   through months that produced no completed plan instead of being silently dropped.
Invariant: Σ(units·price) ≤ X_spendable; per-pick drift from target weight shown in the plan table.
Residual < min(price of picks still under cap), OR all picks are at cap (cap-bound residual).
```
Explanation output per pick: target %, actual %, units × price, and which rule produced any drift.

## 5. Feedback loop ("reinforcement", the honest version)
True RL is out (one decision/month, no counterfactuals, years to converge — docs/07 §2). Instead a
transparent bandit-flavored score adjustment. Return bases per docs/08 §3 (holding leg =
exchange price since actual buy; benchmark = TRI; peers = NAV).

```
For each held ETF, monthly, computed PER LOT then aggregated value-weighted to the holding:
  excess  = holding price return since buy − benchmark TRI return over the same window
  peerGap = holding return − median(same-index/cohort peers' NAV return) same window
Status: OUTPERFORM (excess ≥ +1% AND peerGap ≥ 0) | LAG (excess ≤ −3% for 2 consecutive months) | INLINE

Adjustment recurrence (exact; Δm = calendar months since previous as_of; adj_0 = 0 when no prior
feedback_scores row exists; per-lot excess/peerGap aggregate to the holding weighted by CURRENT
MARKET VALUE; docs/08 §7):
  theme_adj_t = clamp( theme_adj_{t−1} · 2^(−Δm/6) + inc_theme , −12, +12 )
  etf_adj_t   = clamp( etf_adj_{t−1}   · 2^(−Δm/6) + inc_etf   ,  −8,  +8 )
  inc_theme = +6 if net OUTPERFORM, −6 if net LAG, else 0, where (MV = current market value of
              the theme's held ETFs by status):
              net OUTPERFORM ⇔ MV(OUTPERFORM) > MV(LAG); net LAG ⇔ MV(LAG) > MV(OUTPERFORM);
              equal (incl. all-INLINE) ⇒ 0
  inc_etf   = +4 / −4 / 0 per ETF by its own status
feedback_scores.adj stores the post-decay cumulative as of as_of (docs/05); the rows are
computed and persisted at the START of the theme-rank pipeline stage (before any ranking reads
them — docs/10 §3).
etf_adj is applied as S_etf_final = S_etf + etf_adj (§3.2); theme_adj per §2.4.

Stickiness rule: an INLINE-or-better incumbent beats a challenger unless the challenger's
S_etf_final exceeds the incumbent's S_etf_final by >8 points. NOTE (deliberate): since etf_adj
(±8) is inside S_etf_final, a maximally-rewarded incumbent enjoys up to 16 points of moat
(8 adj + 8 margin) — loyalty compounds by design and both numbers are shown in the UI.
Rotation rule: LAG for 2 consecutive runs ⇒ propose rotation, BUT the proposal must show the tax
drag of selling now (docs/04 sell planner) and the after-tax breakeven; if lot is 10–12 months old,
default advice is "hold to LTCG date <date>, then rotate" unless drawdown vs peers > 10%.
```
Everything above is displayed with its inputs — the user sees why the machine changed its mind.

## 6. Seed theme table (initial `themes` + investability as of mid-2026 — verified 2026-07-23 by
the Phase 0 data-verifier against AMFI NAVAll + Yahoo; per-ETF AUM values remain `VERIFY-AT-SEED`)

Note on the "Investable" column below: `themes.investable` (docs/05) is a plain boolean —
structural investability (§2.2: "≥1 ETF in theme_etf_map passes all ETF eligibility gates").
"Partial" in this table is prose shorthand for "structurally investable (`investable=true`,
schema-correct) but its sole ETF frequently fails a runtime gate" — not a third schema state.
`ai_global_tech` is seeded `investable=true` because MON100 exists and can pass the gates in
months it isn't premium-blocked; gate G6 (§3.1) is what actually excludes it most months.
| key | Investable | benchmark_series (source) | Representative index/ETFs |
|---|---|---|---|
| broad_core | yes | NIFTY 50 TRI (niftyindices) | Nifty 50 ETFs (Nippon BeES, SBI, ICICI, HDFC…); core index fixed per §1 |
| defence | yes | NIFTY INDIA DEFENCE TRI (niftyindices) | Motilal Oswal Defence ETF (`MODEFENCE.NS`) and peers |
| manufacturing | yes | NIFTY INDIA MANUFACTURING TRI (niftyindices) | Mirae/Motilal/Nippon Manufacturing ETFs |
| infrastructure | yes | NIFTY INFRASTRUCTURE TRI (niftyindices) | ICICI, Motilal Infra ETFs |
| psu_value | yes | NIFTY CPSE TRI (niftyindices; canonical for the theme) | CPSE ETF, Bharat 22 (`ICICIB22.NS`), PSU Bank BeES |
| it_digital | yes | NIFTY IT TRI (niftyindices) | ABSL/Axis/DSP Nifty IT ETFs |
| ai_global_tech | partial | MON100 NAV series (`nav_proxy`, INR — canonical; NASDAQ-100 TR is USD and docs/02 sources no FX, so all benchmark series stay INR) | NASDAQ 100 FoF/ETF (intl flags; MON100 at ~20% premium Jul-2026 — G6 blocks, expected steady-state for capped intl ETFs) |
| debt_liquid | yes | pinned liquid ETF NAV series (`nav_proxy`) | Liquid/overnight ETFs (Liquid BeES and peers) — exists so the conservative non-equity sleeve (§1) has a scored, deterministic cohort. `VERIFY-AT-SEED`: prefer growth-NAV variants — daily-IDCW liquid ETFs pin NAV at ₹1000, producing a zero-return series that degenerates momentum/peerReturn (docs/07 §12 growth-variant rule applies here too) |
| gold | yes | largest gold ETF NAV series, flagged `nav_proxy` (no TRI exists for commodity ETFs) | Gold BeES, Axis/ABSL Gold ETFs |
| silver | yes | largest silver ETF NAV series, flagged `nav_proxy` | Silver BeES, ABSL Silver ETF |
| consumption | yes | NIFTY INDIA CONSUMPTION TRI (niftyindices) | Axis/ICICI/Kotak Consumption ETFs |
| metals_commodities | yes | NIFTY METAL TRI (niftyindices) | Groww/ICICI/Mirae Metal ETFs |
| energy | yes | NIFTY ENERGY TRI (niftyindices) | Mirae/Motilal Energy ETFs |
| water | **no** | — | No Indian ETF — proxy note: infra/utilities exposure only |
| rare_earth | **no** | — | No Indian ETF — proxy note: metals/mining partial proxy; global thematic not accessible cleanly (re-verified Jul-2026) |

`nav_proxy` benchmark series are labeled "price/NAV proxy, not TRI" wherever displayed. Verify
tickers, scheme codes (beware legacy duplicates — docs/02 §2), and AUMs against the NSE ETF list +
AMC pages during step-1 seeding.
