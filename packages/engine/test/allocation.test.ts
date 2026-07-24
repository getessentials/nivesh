import { describe, expect, it } from 'vitest';
import {
  boundedSoftmax, softmaxBounds, withinThemeSplit, withinThemeSplitPostDedup, splitSleeves,
  allocPaiseForWeight, remainderPass, type RemainderPick, type ThemedPick,
} from '../src/allocation.ts';
import { oneperIndexDedup } from '../src/gates.ts';

describe('boundedSoftmax', () => {
  it('reproduces the docs/03 §4 worked example exactly: scores {90,30,30} -> {0.50,0.25,0.25}', () => {
    const w = boundedSoftmax([90, 30, 30]);
    expect(w[0]).toBeCloseTo(0.50, 10);
    expect(w[1]).toBeCloseTo(0.25, 10);
    expect(w[2]).toBeCloseTo(0.25, 10);
    expect(w[0]! + w[1]! + w[2]!).toBeCloseTo(1, 10);
  });

  it('N=1: single theme gets 100% regardless of score (bounds inapplicable)', () => {
    expect(boundedSoftmax([12345])).toEqual([1]);
  });

  it('N=2: bounds are [35%,65%], not forced 50/50', () => {
    const w = boundedSoftmax([100, 10]); // extreme skew
    expect(w[0]).toBeCloseTo(0.65, 6);
    expect(w[1]).toBeCloseTo(0.35, 6);
    expect(w[0]! + w[1]!).toBeCloseTo(1, 10);
  });

  it('N=2 with near-equal scores stays close to 50/50 but within bounds', () => {
    const w = boundedSoftmax([50, 50]);
    expect(w[0]).toBeCloseTo(0.5, 10);
    expect(w[1]).toBeCloseTo(0.5, 10);
  });

  it('N=5 all-equal scores: uniform 20% each, within [10%,50%]', () => {
    const w = boundedSoftmax([40, 40, 40, 40, 40]);
    w.forEach((x) => expect(x).toBeCloseTo(0.2, 10));
  });

  it('always sums to 1 and respects [lo,hi] for a spread of adversarial score sets (N=3..5)', () => {
    const cases: number[][] = [
      [100, 0, 0], [100, 20, 0, 0], [100, 20, 20, 20, 20],
      [0, 0, 0, 0, 0], [100, 99, 1, 1, 1], [5, 4, 3, 2, 1],
      [100, 100, 100, 0, 0], [-50, -50, -50], [1, 1, 100],
    ];
    for (const scores of cases) {
      const w = boundedSoftmax(scores);
      const { lo, hi } = softmaxBounds(scores.length);
      const sum = w.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 9);
      for (const x of w) {
        expect(x).toBeGreaterThanOrEqual(lo - 1e-9);
        expect(x).toBeLessThanOrEqual(hi + 1e-9);
      }
    }
  });

  it('handles an empty score list', () => {
    expect(boundedSoftmax([])).toEqual([]);
  });

  it('throws rather than silently returning Σw != 1 beyond the supported domain (n<=5)', () => {
    expect(() => boundedSoftmax(new Array(11).fill(50))).toThrow(/MAX_SUPPORTED_THEMES/);
  });

  it('throws on a non-finite score rather than silently corrupting the weight vector with NaN', () => {
    expect(() => boundedSoftmax([50, NaN, 30])).toThrow(/not finite/);
    expect(() => boundedSoftmax([50, Infinity, 30])).toThrow(/not finite/);
  });
});

describe('withinThemeSplit', () => {
  it('a single pick gets 100%', () => {
    expect(withinThemeSplit(['only'])).toEqual([1]);
  });
  it('two or more picks: 70/30 to the top two, 0 beyond', () => {
    expect(withinThemeSplit(['a', 'b'])).toEqual([0.70, 0.30]);
    expect(withinThemeSplit(['a', 'b', 'c', 'd'])).toEqual([0.70, 0.30, 0, 0]);
  });
  it('empty list', () => {
    expect(withinThemeSplit([])).toEqual([]);
  });
});

describe('withinThemeSplitPostDedup (docs/03 §3.3: 70/30 re-applies over the post-dedup list)', () => {
  function pick(etfId: number, themeKey: string, underlyingIndex: string, sEtfFinal: number): ThemedPick {
    return { etfId, themeKey, underlyingIndex, sEtfFinal, terPct: 0.5, aumCr: 1000 };
  }

  it('a theme that loses one of its two picks to cross-theme index dedup falls to 100%, not 70%', () => {
    // Theme "gold" has 2 picks, but pick #2 shares an index with a HIGHER-scored pick from a
    // different theme ("nav_proxy_gold_index") and loses the dedup — gold is left with 1 pick.
    const allPicks = [
      pick(1, 'gold', 'GOLD_INDEX', 80),        // survives (theme gold, pick 1)
      pick(2, 'gold', 'GOLD_INDEX_2', 60),      // survives on its own index... (kept separate below)
      pick(3, 'other_theme', 'GOLD_INDEX_2', 95), // wins the GOLD_INDEX_2 collision, different theme
    ];
    const { kept } = oneperIndexDedup(allPicks);
    const weighted = withinThemeSplitPostDedup(kept);

    const goldWeights = weighted.filter((w) => w.pick.themeKey === 'gold');
    expect(goldWeights).toHaveLength(1); // pick #2 lost the dedup, only pick #1 survives for "gold"
    expect(goldWeights[0]!.weight).toBe(1); // 100%, not 70% (docs/03 §3.3)
  });

  it('a theme with both picks surviving dedup keeps the normal 70/30 split', () => {
    const picks = [pick(1, 'it_digital', 'NIFTY_IT', 90), pick(2, 'it_digital', 'NIFTY_IT_ALT', 70)];
    const { kept } = oneperIndexDedup(picks); // distinct indices -> both survive
    const weighted = withinThemeSplitPostDedup(kept);
    expect(weighted.map((w) => w.weight).sort((a, b) => b - a)).toEqual([0.70, 0.30]);
  });

  it('re-sorts by S_etf_final within each theme (input order does not determine the split)', () => {
    const picks = [pick(1, 'x', 'IDX_A', 50), pick(2, 'x', 'IDX_B', 90)]; // lower score listed first
    const weighted = withinThemeSplitPostDedup(picks);
    const byEtfId = Object.fromEntries(weighted.map((w) => [w.pick.etfId, w.weight]));
    expect(byEtfId[2]).toBe(0.70); // etfId 2 has the higher score -> gets 70%, despite being listed second
    expect(byEtfId[1]).toBe(0.30);
  });

  it('multiple themes are split independently', () => {
    const picks = [
      pick(1, 'a', 'IDX_A1', 80), pick(2, 'a', 'IDX_A2', 60),
      pick(3, 'b', 'IDX_B1', 50),
    ];
    const weighted = withinThemeSplitPostDedup(picks);
    expect(weighted.find((w) => w.pick.etfId === 3)!.weight).toBe(1); // theme 'b' has just 1 pick -> 100%
  });
});

describe('splitSleeves', () => {
  it('splits X_spendable per profile percentages, each sleeve floored independently (docs/08 §5)', () => {
    // equity_pct=75, coreShare=65 (moderate profile numbers), X=10,000,000 paise (Rs 1L)
    const { corePaise, satellitePaise, nonEquityPaise, flooringShortfallPaise } =
      splitSleeves(10_000_000n, 75, 65);
    // equity sleeve = 75% of 1e7 = 7,500,000; core = 65% of that = 4,875,000; satellite = 35% = 2,625,000
    // non-equity = 25% of 1e7 = 2,500,000
    expect(corePaise).toBe(4_875_000n);
    expect(satellitePaise).toBe(2_625_000n);
    expect(nonEquityPaise).toBe(2_500_000n);
    expect(flooringShortfallPaise).toBe(0n); // exact division here, no flooring drift
  });

  it('flooring shortfall is captured, not silently lost, when the split does not divide evenly', () => {
    const { corePaise, satellitePaise, nonEquityPaise, flooringShortfallPaise } =
      splitSleeves(10_000_001n, 75, 65); // one extra paisa vs the clean case above
    expect(corePaise + satellitePaise + nonEquityPaise + flooringShortfallPaise).toBe(10_000_001n);
  });

  it('sleeves are computed independently from X_spendable, not via nested flooring', () => {
    // A case where floor(a*floor(b*X)) would differ from floor(a*b*X) if nested — verify sum
    // still reconciles via the shortfall regardless of profile percentages chosen.
    const { corePaise, satellitePaise, nonEquityPaise, flooringShortfallPaise } =
      splitSleeves(1_234_567n, 82, 57);
    expect(corePaise + satellitePaise + nonEquityPaise + flooringShortfallPaise).toBe(1_234_567n);
  });
});

describe('allocPaiseForWeight', () => {
  it('floors weight*sleevePaise (the one float->paise crossing, docs/08 §5)', () => {
    expect(allocPaiseForWeight(0.3, 1000n)).toBe(300n);
    expect(allocPaiseForWeight(1 / 3, 1000n)).toBe(333n); // floors, not rounds
  });
});

describe('remainderPass', () => {
  function pick(id: string, price: number, targetWeight: number, score: number, ter = 0.5, etfId = 1): RemainderPick {
    return { id, pricePaise: BigInt(price), targetWeightOfXSpendable: targetWeight, sEtfFinal: score, terPct: ter, etfId };
  }

  it('throws on a non-positive price instead of looping forever (a zero price is never ' +
     'unaffordable and never grows its weight, so it would never trip either loop-exit check)', () => {
    const picks = [pick('a', 0, 0.5, 90)];
    expect(() => remainderPass(picks, [0n], 1000n, 100n)).toThrow(/non-positive price/);
  });

  it('spends the pool one unit at a time on the highest-scored eligible pick', () => {
    const picks = [pick('a', 100, 0.5, 90), pick('b', 100, 0.5, 80)];
    const result = remainderPass(picks, [0n, 0n], 1000n, 250n);
    // pool=250: buy 'a' (100, weight 100/1000=0.10<=0.5+.02), buy 'a' again (200/1000=0.20<=cap),
    // pool remaining 50 < 100 -> stop. 'a' bought twice (highest score, both under cap).
    expect(result.extraUnits).toEqual([2, 0]);
    expect(result.residualPaise).toBe(50n);
    expect(result.capBound).toBe(false); // stopped because nothing was affordable, not cap
  });

  it('respects the weight cap + 2pp tolerance, moving to the next pick once capped', () => {
    const picks = [pick('a', 100, 0.10, 90), pick('b', 100, 0.50, 80)];
    // xSpendable=1000: 'a' caps at 0.10+0.02=0.12 of 1000=120 -> only 1 unit of 'a' fits (100/1000=0.10 ok,
    // 200/1000=0.20 > 0.12 not ok). Then 'b' should receive the rest.
    const result = remainderPass(picks, [0n, 0n], 1000n, 500n);
    expect(result.extraUnits[0]).toBe(1); // 'a' capped after 1 unit
    expect(result.extraUnits[1]).toBeGreaterThan(1); // 'b' absorbs the remaining affordable units
  });

    it('reports capBound=true when the pool still affords a pick but every pick is over cap', () => {
    const picks = [pick('a', 100, 0.05, 90)]; // cap = 0.05+0.02=0.07 of 1000 = 70 paise -> even 1 unit (100) exceeds cap
    const result = remainderPass(picks, [0n], 1000n, 500n);
    expect(result.extraUnits).toEqual([0]);
    expect(result.capBound).toBe(true); // pool (500) could afford the 100-paise pick, but it's over cap
    expect(result.residualPaise).toBe(500n);
  });

  it('ties break by lower TER, then lower etfId, when scores are equal', () => {
    const picks = [
      pick('a', 100, 1, 50, 1.0, 5),
      pick('b', 100, 1, 50, 0.5, 2), // lower TER -> wins the tie
    ];
    const result = remainderPass(picks, [0n, 0n], 1000n, 100n);
    expect(result.extraUnits).toEqual([0, 1]); // 'b' (lower TER) gets the single affordable unit
  });

  it('never overspends the pool (units*price sums to at most the pool)', () => {
    const picks = [pick('a', 137, 1, 90), pick('b', 59, 1, 80)];
    const result = remainderPass(picks, [0n, 0n], 10_000n, 1000n);
    const spent = result.extraUnits.reduce((s, u, i) => s + BigInt(u) * picks[i]!.pricePaise, 0n);
    expect(spent + result.residualPaise).toBe(1000n);
  });
});
