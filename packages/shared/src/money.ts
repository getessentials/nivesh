/**
 * Rupee <-> paise conversion. Pure, no I/O. This is the ONLY place a decimal rupee amount
 * (as it arrives from Yahoo/AMFI/niftyindices) is allowed to touch a float — the result is
 * always an integer paise value from here on (docs/08 §5-6 float/paise boundary).
 */

/** Round a rupee amount (float) to integer paise, half-up (docs/08 §6 rounding rule). */
export function rupeesToPaise(rupees: number): bigint {
  if (!Number.isFinite(rupees)) throw new Error(`rupeesToPaise: not finite: ${rupees}`);
  const negative = rupees < 0;
  const abs = Math.abs(rupees);
  // Naive `abs * 100 + 0.5` misrounds exact half-paisa values (e.g. 1.005) because IEEE754
  // stores 1.005 as ~1.00499999999999989 and the early *100 multiply bakes that error in
  // before rounding ever happens. Instead, format at 8 rupee-decimal-digit precision — well
  // beyond any real price/NAV source's precision (max 4dp) — which lets toFixed's own
  // correctly-rounded decimal conversion resolve the true binary value first; only then do
  // exact integer (BigInt) half-up rounding on the resulting digit string.
  const fixed = abs.toFixed(8); // e.g. "273.09430000"
  const dot = fixed.indexOf('.');
  const digits = fixed.slice(0, dot) + fixed.slice(dot + 1); // abs * 1e8, as an integer string
  const scaledByE8 = BigInt(digits);
  const paise = (scaledByE8 + 500_000n) / 1_000_000n; // half-up: +0.5 paisa-equivalent, then floor
  return negative ? -paise : paise;
}

export function paiseToRupees(paise: bigint | number): number {
  return Number(paise) / 100;
}
