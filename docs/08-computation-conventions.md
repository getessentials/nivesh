# 08 — Computation Conventions (shared deterministic-math contract)

Referenced by docs/03 and docs/04. Every formula in those docs resolves ambiguity by the rules
here. `packages/engine` implements this file once; nothing re-defines these conventions locally.

## 1. Percentile definition (used by every `percentile` in docs/03)
- Method: **mid-rank (Hazen)** — `pct = (r − 0.5) / n`, where `r` is the 1-based **ascending**
  rank (r = 1 for the smallest normalized value) within the cohort after direction normalization,
  `n` = cohort size.
- Ties: tied values share the **mean of their ranks** (mid-rank), then the formula applies.
- Direction normalization (higher normalized value = better = higher percentile):

| Factor | Raw input | Normalized as |
|---|---|---|
| trackingQuality | tracking_diff (usually negative) | `−|tracking_diff|` → **fidelity: |TD| closest to zero is best; positive TD is NOT rewarded** (it's deviation, not skill). Blend when TD_3y exists: `0.6·pct(−|TD_1y|) + 0.4·pct(−|TD_3y|)`, else `pct(−|TD_1y|)`. `pct(−|TD_3y|)` is computed over the SUB-COHORT of members with non-null TD_3y (n = that count); members without TD_3y use the 1y percentile alone — the §2 cohort-wide shrink applies to return windows, not metrics fields |
| liquidity | adtv_paise | `log10(adtv_paise)` |
| cost | ter_pct | `−ter_pct` |
| scale | aum_cr | `log10(aum_cr)` |
| peerReturn | CAGR over max common window | as-is |
| momentum (ETF & theme) | 6m total return | as-is |
| trend (theme) | 12m total return | as-is |

- Degenerate cohorts:
  - `n = 1` (even after the full-universe fallback): percentile = **0.5**, item tagged
    `"no_cohort"` in `factor_json`.
  - ETF cohort `< 4`: fall back to scoring vs the full thematic universe, tag `"small_cohort"`
    (docs/07 QNT-1).
  - **Theme cohort `< 4`** (investable themes with a usable benchmark series): same fallback is
    impossible (there is no larger universe), so with `n ∈ {2,3}` percentiles are computed as-is
    over the small cohort and every theme is tagged `"small_theme_cohort"`; with `n = 1` the
    percentile components are 0.5.

## 2. Return windows & series alignment
- Windows (6m, 12m, 1y, 3y, 30d) are **calendar offsets** anchored at the **as-of date** = the
  latest date on which every series required by the computation has data (for a monthly run,
  normally the run date itself, since the run fires after all ingesters — docs/10 §2).
- **Endpoint selection**: the endpoint observation = the latest observation **on or before** the
  nominal window edge; if none exists within 5 trading days on-or-before, the earliest observation
  after the edge within 5 trading days. The same rule anchors "since buy" windows (docs/03 §5)
  when a series has no observation on the buy date.
- A return over a window is computable only if both endpoints resolve under that rule; otherwise
  the window shrinks — **cohort-wide**: for any percentiled factor, ALL cohort members' windows
  shrink to the max common window across the cohort (returns stay comparable); a member too short
  even for the common window (or a common window < 60 trading days) gets neutral 0.5 with an
  `"insufficient_history"` tag.
- Series are aligned on common trading dates. No forward-filling for return computation; a missing
  interior date simply doesn't contribute a daily observation.
- CAGR: `(end/start)^(252/d) − 1`, where `d` = the number of **trading-day intervals** between
  the two endpoint observations (observations − 1). If history < 3y, use the max common window
  across the cohort and apply the shortHistoryPenalty (docs/03 §3.2).
- **"30d" in gates G3/G6** = the last 30 **trading days** per the nse_holidays calendar, requiring
  ≥ 20 observations with the needed fields present (both price and NAV for G6); fewer ⇒ the gate
  fails with reason `insufficient_data`.

## 3. Return basis per series (the NAV / price / TRI contract)
| Computation | Basis |
|---|---|
| ETF scoring factors (peerReturn, momentum) | **NAV** (fund's clean total-return proxy; growth plans) |
| Theme momentum / trend | benchmark series per docs/03 §6 (TRI where it exists; flagged proxy otherwise) |
| Benchmark side of every comparison | **TRI** (never price index) |
| Feedback holding return (docs/03 §5) | **exchange price** — user's actual buy price → latest close (what the user realizes) |
| Peer legs in the feedback peerGap | NAV |
| diversify correlation inputs | NAV daily returns |
| Charts (docs/01 §3.3) | each series labeled with its basis; holding = price, benchmark = TRI, rivals = NAV |

Price/NAV divergence is never mixed into a return series; it is surfaced separately as
premium/discount (gate G6).

Known accepted bias: `nav_proxy` theme benchmark series (gold/silver/etc., docs/03 §6) are ETF
NAVs net of TER (~0.1–0.5%/yr drag) while equity themes use gross TRI — a small systematic
momentum penalty for proxy themes in the cross-theme percentile. Accepted deliberately (adding
TER back would manufacture precision the inputs don't have); both builders produce identical
numbers either way.

## 4. diversify factor (docs/03 §2.3) — exact construction
- Portfolio series: **frozen current holdings**, weighted by current market value, applied backward
  over the window (composition changes during the window are ignored — this measures "does this
  theme diversify what I hold today").
- Daily returns: NAV-based per ETF, value-weight-summed. Correlation = **Pearson**, on the
  aligned daily-return pairs.
- Window: min(1y, common history). If overlapping observations < **120 trading days**, or the user
  has no holdings: `diversify = 0.5`, tagged `"insufficient_history"` / `"no_holdings"`.
- Single-holding portfolios: computed normally (correlation of theme series vs that one ETF's series).
- The about-to-be-bought core sleeve is **not** included (only currently held lots count).

## 5. Float ↔ paise boundary
Floats are permitted in scoring, percentiles, correlations, softmax, and weight derivation.
Every rupee figure crosses to integer paise **exactly once per level**, and always by flooring
an integer input:
```
sleeve_paise[s]  = floor(sleeve_share_s × X_spendable)      // each sleeve independently from
                                                            // X_spendable — NO nested flooring
alloc_paise[i]   = floor(weight_i × sleeve_paise[s])        // weights applied to the integer sleeve
```
All flooring shortfalls join the remainder pool (docs/03 §4). Downstream of that line — units,
charges, tax — all arithmetic is integer paise. No float ever appears in a tax or unit computation.

## 6. Rounding rules (charges & tax — docs/04 depends on these)
1. Each percentage charge is computed on the **gross consideration of the market order** (buy or
   sell leg), in unrounded paise, then rounded **half-up to the paisa, per charge, independently**.
2. GST is computed on the **sum of the unrounded** applicable bases (brokerage + exchange txn +
   SEBI), then rounded half-up to the paisa once.
3. Flat charges (DP) are exact paise from config.
4. When one market sell spans multiple FIFO slices (docs/04 E4), the single charges pass is
   apportioned to slices **pro-rata by consideration**, with the **largest-remainder method**
   fixing paise drift so slice charges sum exactly to the order's charges; remainder ties are
   broken **in favor of the earlier lot (FIFO order)**.
5. Tax: `tax_with_cess = max(0, gain_taxable) × rate × 1.04` computed unrounded, rounded **half-up
   to the paisa once at the end** (per slice). A loss slice pays zero tax; the loss is recorded as
   STCL/LTCL for the set-off display (docs/04 §2.5) — tax is never negative. The FY report
   additionally shows the statutory
   s.288A/288B nearest-₹10 rounded figure alongside, labeled as such; the engine's canonical
   number is the paisa-precise one. (Statutory STT rupee-rounding on contract notes:
   `VERIFY-AT-SEED` against the owner's actual contract note; fixture uses paisa rounding.)

## 7. Misc conventions
- breadth (docs/03 §2.3): `breadth_raw = 0.5·pct(eligible_etf_count) + 0.5·pct(log10(total_aum_cr))`,
  percentiles per §1 over the theme scoring cohort (docs/03 §2.3 — investable themes excluding
  broad_core).
- Precedence: docs/03 §2.3's "<12m usable benchmark series ⇒ momentum/trend neutral 0.5" preempts
  the §2 cohort-wide shrink for THEME momentum/trend; the shrink rule governs ETF-level return
  factors.
- shortHistoryPenalty: −5 points subtracted from the **total S_etf after component summation**;
  S_etf floored at 0 and capped at 100.
- softmax in docs/03 §4 uses natural exponent: `w_i = exp(S_i/20) / Σ exp(S_j/20)`.
- All clamps are inclusive. `clamp(x, lo, hi) = min(max(x, lo), hi)`.
- Months between runs (feedback decay Δm): difference in calendar months between `run_month`
  values (a skipped month ⇒ Δm = 2, decay still applies).
