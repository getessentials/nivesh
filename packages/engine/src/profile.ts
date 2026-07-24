/** Profile mapping (docs/03 §1). */

export type RiskAppetite = 'conservative' | 'moderate' | 'aggressive';

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/** equity_pct(age, risk) = clamp(115 - age + riskAdj, 40, 90) (docs/03 §1). */
export function equityPct(age: number, risk: RiskAppetite): number {
  if (!Number.isFinite(age)) {
    // NaN propagates silently through every clamp comparison (all false) — the only failure
    // several calls downstream is a cryptic `BigInt(Math.round(NaN))` RangeError in
    // splitSleeves that names neither "age" nor "profile". Fail loudly here instead, at the
    // actual point of the bad input.
    throw new Error(`equityPct: age must be a finite number, got: ${age}`);
  }
  const riskAdj = risk === 'conservative' ? -10 : risk === 'aggressive' ? 10 : 0;
  return clamp(115 - age + riskAdj, 40, 90);
}

/** Theme count range: engine picks the max allowed by supply, within this range (docs/03 §1). */
export function themeCountRange(risk: RiskAppetite): { min: number; max: number } {
  if (risk === 'conservative') return { min: 1, max: 2 };
  if (risk === 'aggressive') return { min: 3, max: 5 };
  return { min: 2, max: 4 };
}

/** Core share of the equity sleeve, as a whole-number percentage (docs/03 §1: 80/65/50). */
export function coreSharePct(risk: RiskAppetite): number {
  if (risk === 'conservative') return 80;
  if (risk === 'aggressive') return 50;
  return 65;
}
