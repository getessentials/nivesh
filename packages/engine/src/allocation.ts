/**
 * Allocation of X_spendable across sleeves and picks (docs/03 §4, docs/08 §5). Every function
 * here is a composable building block; the monthly-run pipeline (a later build step) wires them
 * together with live theme/ETF data. Floats are fine up through weight derivation (docs/08 §5);
 * the ONE crossing to integer paise per level is explicit and never re-floated afterward.
 */
import type { IndexedPick } from './gates.ts';

/** N-dependent softmax bounds (docs/03 §4 step 2). N=1 has no bounds (100%, trivial). */
export function softmaxBounds(n: number): { lo: number; hi: number } {
  if (n <= 1) return { lo: 1, hi: 1 };
  if (n === 2) return { lo: 0.35, hi: 0.65 };
  return { lo: 0.10, hi: 0.50 };
}

/**
 * Two-phase bounded softmax (docs/03 §4 step 2): w_i = exp(S_i/20) normalized, then Phase A
 * clips/freezes upper-bound violators and renormalizes the rest, THEN (only once Phase A is
 * fully stable) Phase B clips/freezes lower-bound violators and renormalizes — re-checking the
 * upper bound each Phase B pass, since renormalizing over a shrinking unfrozen set can push a
 * survivor back over `hi`. The phases must NOT be merged into one combined bounds-check pass:
 * doing so can freeze every element in a single pass before any renormalization occurs, which
 * for the docs' own worked example ({90,30,30}, N=3) yields weights summing to 0.70, not 1 —
 * this two-phase order is exactly what makes Σw = 1 provable.
 */
/** Max themes per run (docs/03 §1 themeCountRange: aggressive tops out at 5). boundedSoftmax's
 *  Σw=1 guarantee depends on n*lo <= 1 <= n*hi, which holds for every n in the real call domain
 *  (n<=5) but is NOT true for arbitrarily large n at lo=0.10 (e.g. n=11 -> n*lo=1.1) — guarded
 *  explicitly below so a future misuse fails loudly instead of silently returning Σw != 1. */
export const MAX_SUPPORTED_THEMES = 5;

export function boundedSoftmax(scores: readonly number[]): number[] {
  const n = scores.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  if (n > MAX_SUPPORTED_THEMES) {
    throw new Error(
      `boundedSoftmax: n=${n} exceeds MAX_SUPPORTED_THEMES=${MAX_SUPPORTED_THEMES} — the ` +
      `[10%,50%] bound at n>=3 is only feasible (n*lo<=1<=n*hi) up to n=${MAX_SUPPORTED_THEMES}`
    );
  }
  scores.forEach((s, i) => {
    if (!Number.isFinite(s)) {
      // NaN/Infinity fails every `> hi` / `< lo` freeze check silently (both are always false),
      // so a bad score would corrupt the whole weight vector with no error at all — loud and
      // specific here beats a confusing downstream BigInt(NaN) crash several calls later.
      throw new Error(`boundedSoftmax: score at index ${i} is not finite (${s})`);
    }
  });
  const { lo, hi } = softmaxBounds(n);

  const raw = scores.map((s) => Math.exp(s / 20));
  const frozen = new Array<boolean>(n).fill(false);
  const frozenValue = new Array<number>(n).fill(0);
  const currentW = new Array<number>(n).fill(0);

  function renormalizeUnfrozen(): void {
    const unfrozenIdx: number[] = [];
    for (let i = 0; i < n; i++) if (!frozen[i]) unfrozenIdx.push(i);
    const frozenMass = frozen.reduce((s, f, i) => s + (f ? frozenValue[i]! : 0), 0);
    const remainingMass = 1 - frozenMass;
    const unfrozenSumRaw = unfrozenIdx.reduce((s, i) => s + raw[i]!, 0);
    for (const i of unfrozenIdx) {
      currentW[i] = unfrozenSumRaw > 0
        ? (raw[i]! / unfrozenSumRaw) * remainingMass
        : remainingMass / unfrozenIdx.length;
    }
  }

  renormalizeUnfrozen(); // initial unbounded softmax

  // Phase A: upper bounds only, to full stability.
  for (let pass = 0; pass < n; pass++) {
    let anyNewFreeze = false;
    for (let i = 0; i < n; i++) {
      if (!frozen[i] && currentW[i]! > hi) { frozen[i] = true; frozenValue[i] = hi; anyNewFreeze = true; }
    }
    if (!anyNewFreeze) break;
    renormalizeUnfrozen();
  }

  // Phase B: lower bounds, with a same-pass upper-bound re-check (docs/03 §4 step 2).
  for (let pass = 0; pass < n; pass++) {
    let anyLoFreeze = false;
    for (let i = 0; i < n; i++) {
      if (!frozen[i] && currentW[i]! < lo) { frozen[i] = true; frozenValue[i] = lo; anyLoFreeze = true; }
    }
    if (anyLoFreeze) { renormalizeUnfrozen(); continue; }
    let anyHiFreeze = false;
    for (let i = 0; i < n; i++) {
      if (!frozen[i] && currentW[i]! > hi) { frozen[i] = true; frozenValue[i] = hi; anyHiFreeze = true; }
    }
    if (!anyHiFreeze) break;
    renormalizeUnfrozen();
  }

  return currentW.map((w, i) => (frozen[i] ? frozenValue[i]! : w));
}

/** Within-theme split (docs/03 §4 step 2): `sortedDescendingScores` must already be sorted
 *  descending by S_etf_final (ties: lower TER, then lower etf_id — the caller's sort order).
 *  1 pick -> 100%; 2+ -> 70/30 to the top two, 0% beyond (thematic depth beyond 2 adds churn). */
export function withinThemeSplit(sortedDescendingScores: readonly unknown[]): number[] {
  const n = sortedDescendingScores.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  return [0.70, 0.30, ...new Array(n - 2).fill(0)];
}

export interface ThemedPick extends IndexedPick {
  themeKey: string;
}

/**
 * Composes one-per-index dedup with the within-theme split (docs/03 §3.3: "When dedup removes
 * one of a theme's picks, the 70/30 within-theme split re-applies over the post-dedup ranked
 * list, falling to 100% if one pick remains"). Takes the SURVIVORS of `oneperIndexDedup` (the
 * `kept` array — dedup already happened; this function doesn't repeat it), regroups by theme,
 * re-sorts each theme's survivors by S_etf_final descending, and applies `withinThemeSplit` to
 * each group independently.
 */
export function withinThemeSplitPostDedup<T extends ThemedPick>(
  dedupedPicks: readonly T[]
): Array<{ pick: T; weight: number }> {
  const byTheme = new Map<string, T[]>();
  for (const p of dedupedPicks) {
    const arr = byTheme.get(p.themeKey) ?? [];
    arr.push(p);
    byTheme.set(p.themeKey, arr);
  }

  const result: Array<{ pick: T; weight: number }> = [];
  for (const group of byTheme.values()) {
    const sorted = [...group].sort((a, b) => b.sEtfFinal - a.sEtfFinal);
    const weights = withinThemeSplit(sorted);
    sorted.forEach((pick, i) => result.push({ pick, weight: weights[i]! }));
  }
  return result;
}

/**
 * Splits X_spendable into core/satellite/non-equity, each floored INDEPENDENTLY from
 * X_spendable — no nested flooring (docs/08 §5). Returns the flooring shortfall too (joins the
 * remainder pool per docs/03 §4 step 3).
 *
 * `equityPct` and `coreSharePct` are always WHOLE-NUMBER percentages by construction (docs/03
 * §1: `equity_pct = clamp(115-age+riskAdj, 40, 90)` is an integer; core/satellite splits are
 * fixed per risk tier at 80/65/50). This lets the whole computation run in exact BigInt
 * arithmetic (no float division at all) rather than floats — computing shares as floats first
 * (e.g. `1 - 0.65`) hits the same IEEE754 near-boundary artifact documented in
 * packages/shared/money.ts, silently losing a paisa on otherwise-clean percentage inputs.
 */
export function splitSleeves(
  xSpendablePaise: bigint,
  equityPct: number,
  coreSharePct: number
): { corePaise: bigint; satellitePaise: bigint; nonEquityPaise: bigint; flooringShortfallPaise: bigint } {
  const equityPctI = BigInt(Math.round(equityPct));
  const corePctI = BigInt(Math.round(coreSharePct));

  const corePaise = (xSpendablePaise * equityPctI * corePctI) / 10_000n;
  const satellitePaise = (xSpendablePaise * equityPctI * (100n - corePctI)) / 10_000n;
  const nonEquityPaise = (xSpendablePaise * (100n - equityPctI)) / 100n;

  const flooringShortfallPaise = xSpendablePaise - corePaise - satellitePaise - nonEquityPaise;
  return { corePaise, satellitePaise, nonEquityPaise, flooringShortfallPaise };
}

/** floor(weight * sleevePaise) — the ONE float->paise crossing per pick (docs/08 §5). */
export function allocPaiseForWeight(weight: number, sleevePaise: bigint): bigint {
  return BigInt(Math.floor(weight * Number(sleevePaise)));
}

export interface RemainderPick {
  id: string;
  pricePaise: bigint;
  /** this pick's target weight as a fraction of X_spendable (docs/03 §4 step 4) */
  targetWeightOfXSpendable: number;
  sEtfFinal: number;
  terPct: number;
  etfId: number;
}

export interface RemainderPassResult {
  /** additional units bought per pick, in the same order as the input picks */
  extraUnits: number[];
  residualPaise: bigint;
  /** true if the loop stopped because every pick was cap-bound (not because the pool ran dry) */
  capBound: boolean;
}

const CAP_TOLERANCE_PP = 0.02; // +2 percentage points, absolute (docs/03 §4 step 4)

/**
 * Greedy remainder pass (docs/03 §4 step 4): spend the leftover pool one unit at a time on the
 * highest-S_etf_final pick that is both affordable and still under its weight cap + 2pp,
 * ignoring units already bought via the floor pass (`baseUnits`/`baseAllocPaise` establish each
 * pick's starting weight before this pass adds more).
 */
export function remainderPass(
  picks: readonly RemainderPick[],
  baseAllocPaise: readonly bigint[],
  xSpendablePaise: bigint,
  pool: bigint
): RemainderPassResult {
  // A zero-or-negative price is never "unaffordable" and its weight never grows, so it would
  // never trip the affordability or cap checks below and the loop would run forever, silently
  // burning the Edge Function's entire wall-clock budget (CLAUDE.md's pipeline constraint) with
  // no error. Prices come from live market data (docs/10 §4's staleness/sanity gates should
  // already exclude this upstream) — this is a defensive floor, not the primary safeguard.
  for (const p of picks) {
    if (p.pricePaise <= 0n) {
      throw new Error(`remainderPass: pick "${p.id}" has a non-positive price (${p.pricePaise} paise)`);
    }
  }

  const n = picks.length;
  const extraUnits = new Array<number>(n).fill(0);
  const spentSoFar = baseAllocPaise.map((p) => p); // running allocated paise per pick (base + extras)
  let remainingPool = pool;

  // Deterministic priority order once: highest S_etf_final, then lower TER, then lower etf_id.
  const priorityOrder = [...picks.keys()].sort((a, b) => {
    const pa = picks[a]!, pb = picks[b]!;
    if (pa.sEtfFinal !== pb.sEtfFinal) return pb.sEtfFinal - pa.sEtfFinal;
    if (pa.terPct !== pb.terPct) return pa.terPct - pb.terPct;
    return pa.etfId - pb.etfId;
  });

  for (;;) {
    let bought = false;
    for (const i of priorityOrder) {
      const pick = picks[i]!;
      if (pick.pricePaise > remainingPool) continue;
      const weightAfter = Number(spentSoFar[i]! + pick.pricePaise) / Number(xSpendablePaise);
      if (weightAfter > pick.targetWeightOfXSpendable + CAP_TOLERANCE_PP) continue;
      extraUnits[i] = extraUnits[i]! + 1;
      spentSoFar[i] = spentSoFar[i]! + pick.pricePaise;
      remainingPool -= pick.pricePaise;
      bought = true;
      break; // re-evaluate priority order from the top after each single-unit purchase
    }
    if (!bought) {
      // If nothing was bought this pass yet some pick IS affordable, every affordable pick must
      // have been rejected on the cap check — that's the "cap-bound residual" case (docs/03 §4
      // step 4). If NO pick is even affordable, the pool is just smaller than the cheapest pick
      // — the ordinary (non-cap-bound) ending.
      const anyPickStillAffordable = picks.some((p) => p.pricePaise <= remainingPool);
      return { extraUnits, residualPaise: remainingPool, capBound: anyPickStillAffordable };
    }
  }
}
