/**
 * Paisa-exact rounding primitives (docs/08 §6). Every percentage-charge and tax computation in
 * this package goes through these — never a naive `basePaise * pct / 100` float computation,
 * which suffers the same near-half-boundary IEEE754 artifact documented in
 * packages/shared/src/money.ts (e.g. `x * pct` landing at 100.49999999999999 instead of 100.5).
 */

/** Half-up round a BigInt fraction (numerator/denominator, denominator > 0) to the nearest integer. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('divRoundHalfUp: denominator must be positive');
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const result = (abs * 2n + denominator) / (denominator * 2n);
  return negative ? -result : result;
}

/**
 * Converts a decimal JS number to an exact BigInt scaled by 10^decimals, via a fixed-precision
 * string round-trip (not `value * 10**decimals`) — the same technique money.ts uses to escape
 * the float near-boundary artifact. `decimals` should be >= the source's real decimal precision
 * (charges_config.value is numeric(12,6): at most 6 decimal digits).
 */
export function scaleDecimalToBigInt(value: number, decimals: number): bigint {
  if (!Number.isFinite(value)) throw new Error(`scaleDecimalToBigInt: not finite: ${value}`);
  const negative = value < 0;
  const abs = Math.abs(value);
  const fixed = abs.toFixed(decimals);
  const dot = fixed.indexOf('.');
  const digits = dot === -1 ? fixed : fixed.slice(0, dot) + fixed.slice(dot + 1);
  const n = BigInt(digits);
  return negative ? -n : n;
}

/**
 * A percentage charge on an integer-paise base, rounded half-up to the paisa (docs/08 §6 rule
 * 1: "computed on the gross consideration ... in unrounded paise, then rounded half-up ...
 * independently"). `pctPercent` is a PERCENTAGE (0.00297 means 0.00297%, i.e. multiply by
 * 0.0000297 as a fraction).
 */
export function chargeFromPct(basePaise: bigint, pctPercent: number): bigint {
  const pctScaled = scaleDecimalToBigInt(pctPercent, 6); // exact integer: pctPercent * 1e6
  // basePaise * (pctPercent/100) = basePaise * pctScaled / (1e6 * 100) = basePaise * pctScaled / 1e8
  return divRoundHalfUp(basePaise * pctScaled, 100_000_000n);
}

/**
 * GST on the SUM of several unrounded percentage bases (docs/08 §6 rule 2: "computed on the sum
 * of the UNROUNDED applicable bases ... then rounded half-up to the paisa ONCE"). Each entry in
 * `basesPaiseUnrounded` is itself an unrounded `basePaise * pct/100` bigint-fraction — represent
 * each as an exact numerator/denominator pair (both scaled to a common 1e8 denominator) and sum
 * numerators before the single final rounding, so summing several unrounded fractions never
 * itself introduces float error.
 */
export function gstOnUnroundedBases(entries: Array<{ basePaise: bigint; pctPercent: number }>, gstPctPercent: number): bigint {
  // sumUnroundedBaseNumerator := (Σ unrounded_base_i) * 1e8, since
  // Σ (basePaise_i * (pctPercent_i * 1e6)) = 1e6 * Σ(basePaise_i * pctPercent_i)
  //                                        = 1e6 * 100 * Σ(basePaise_i * pctPercent_i/100)
  //                                        = 1e8 * Σ unrounded_base_i
  const sumUnroundedBaseNumerator = entries.reduce(
    (sum, e) => sum + e.basePaise * scaleDecimalToBigInt(e.pctPercent, 6),
    0n
  );
  const gstScaled = scaleDecimalToBigInt(gstPctPercent, 6); // gstPctPercent * 1e6
  // gst = (Σ unrounded_base_i) * (gstPctPercent/100)
  //     = (sumUnroundedBaseNumerator / 1e8) * (gstScaled / 1e6) / 100
  //     = sumUnroundedBaseNumerator * gstScaled / 1e16
  return divRoundHalfUp(sumUnroundedBaseNumerator * gstScaled, 10n ** 16n);
}

/**
 * Largest-remainder apportionment of a total integer amount across weighted shares (docs/08 §6
 * rule 4: FIFO-slice charge apportionment; also used for allocation remainder passes elsewhere).
 * Each share gets `floor(total * weight_i / Σweight)`, then the leftover units (total minus the
 * sum of floors) are distributed one-by-one to the largest fractional remainders; ties broken by
 * the provided `tieBreakIndex` order (docs/08 §6 rule 4: "ties broken in favor of the earlier lot").
 */
export function apportionLargestRemainder(
  total: bigint,
  weights: bigint[]
): bigint[] {
  const sumWeights = weights.reduce((s, w) => s + w, 0n);
  if (sumWeights === 0n) {
    if (total !== 0n) throw new Error('apportionLargestRemainder: zero total weight but nonzero total to distribute');
    return weights.map(() => 0n);
  }
  const floors = weights.map((w) => (total * w) / sumWeights);
  const remainders = weights.map((w, i) => ({
    i,
    // remainder = total*w - floor*sumWeights, i.e. the numerator left over (0 <= r < sumWeights)
    r: total * w - floors[i]! * sumWeights,
  }));
  let leftover = total - floors.reduce((s, f) => s + f, 0n);
  // Largest remainder first; ties broken by original index (earlier = first = "earlier lot").
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  const result = [...floors];
  for (const { i } of remainders) {
    if (leftover <= 0n) break;
    result[i] = result[i]! + 1n;
    leftover -= 1n;
  }
  return result;
}
