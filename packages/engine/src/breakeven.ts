/**
 * E5: LAG rotation breakeven solver (docs/04 §4 E5, docs/03 §5 rotation rule). Given a lot
 * approaching its LTCG date, finds the price P* at which selling later (after the LTCG date, at
 * the LTCG rate, net of the remaining exemption) breaks even with selling now (at the STCG
 * rate). Docs are explicit that this is solved on UNROUNDED linear forms and reported as a
 * to-the-paisa APPROXIMATION — unlike the rest of the tax engine, plain floats are the right
 * tool here (docs/04 §4 E5: "reported as an approximation to the paisa").
 *
 * net_later(P) is piecewise-linear with exactly one kink, at the price where the remaining LTCG
 * exemption is exhausted (gain(P) == exemptionRemaining): below the kink, LTCG tax is 0; above
 * it, tax grows linearly with P at the LTCG rate.
 */
import { resolveChargeRows } from './config-resolution.ts';
import type { AssetClass, ChargeConfigRow } from './types.ts';

/** Decomposes a leg's charges into an (unrounded) linear form in price P: amount(P) = slope*qty*P + flatIntercept.
 *  Percentage charges (incl. GST, since GST's base here is itself entirely percentage-based) contribute to
 *  `slope`; flat charges (DP) contribute to `flatIntercept`. Returns both the TOTAL and the DEDUCTIBLE-only form. */
function linearChargeForm(chargeRows: ChargeConfigRow[], side: 'buy' | 'sell') {
  const applicable = chargeRows.filter((c) => c.side === side || c.side === 'both');
  const gstRow = applicable.find((c) => c.chargeKey === 'gst');
  const nonGst = applicable.filter((c) => c.chargeKey !== 'gst');
  const GST_BASE = new Set(['brokerage', 'txn', 'sebi']);

  let slope = 0, deductibleSlope = 0, flat = 0, deductibleFlat = 0;
  for (const row of nonGst) {
    if (row.kind === 'pct') {
      const rate = row.value / 100;
      slope += rate;
      if (row.taxDeductible) deductibleSlope += rate;
    } else {
      flat += row.value;
      if (row.taxDeductible) deductibleFlat += row.value;
    }
  }
  if (gstRow) {
    const gstRate = gstRow.value / 100;
    const gstBaseRate = nonGst.filter((r) => GST_BASE.has(r.chargeKey) && r.kind === 'pct')
      .reduce((s, r) => s + r.value / 100, 0);
    const gstSlope = gstRate * gstBaseRate;
    slope += gstSlope;
    if (gstRow.taxDeductible) deductibleSlope += gstSlope;
  }
  return { slope, deductibleSlope, flat, deductibleFlat };
}

export interface RotationBreakevenInput {
  assetClass: AssetClass;
  qty: number;
  /** current price, paise */
  currentPricePaise: bigint;
  /** this lot's effective cost basis (buy consideration + apportioned deductible buy charges), paise */
  effectiveCostPaise: bigint;
  stcgRatePct: number;
  ltcgRatePct: number;
  cessPct: number;
  /** remaining equity LTCG exemption available to this hypothetical future sell, paise (0 for non-equity). */
  exemptionRemainingPaise: bigint;
  sellDate: string;
  brokerChargeConfigs: readonly ChargeConfigRow[];
  chargeOverrides?: readonly ChargeConfigRow[];
}

export interface RotationBreakevenResult {
  netNowPaise: bigint;
  taxIfNowPaise: bigint;
  /** breakeven price (float approximation, docs/04 §4 E5) */
  breakevenPricePaise: number;
  /** (P0 - P*) / P0 — the price fall that would equalize hold-vs-sell-now */
  dropFraction: number;
}

function taxFlat(gain: number, ratePct: number, cessPct: number): number {
  return Math.max(0, gain) * (ratePct / 100) * (1 + cessPct / 100);
}

export function computeRotationBreakeven(input: RotationBreakevenInput): RotationBreakevenResult {
  const chargeRows = resolveChargeRows(input.brokerChargeConfigs, input.assetClass, input.sellDate, input.chargeOverrides);
  const sellForm = linearChargeForm(chargeRows, 'sell');
  const q = input.qty;
  const P0 = Number(input.currentPricePaise);
  const EC = Number(input.effectiveCostPaise);
  const E = Number(input.exemptionRemainingPaise);

  // net(P) = q*P*(1 - totalSlope) - totalFlat - tax(gain(P))
  // gain(P) = q*P*(1 - deductibleSlope) - deductibleFlat - EC = A*P - B
  const A = q * (1 - sellForm.deductibleSlope);
  const B = sellForm.deductibleFlat + EC;
  const netUnroundedAtP = (P: number, tax: number) => q * P * (1 - sellForm.slope) - sellForm.flat - tax;

  const gainNow = A * P0 - B;
  const taxNow = taxFlat(gainNow, input.stcgRatePct, input.cessPct);
  const netNow = netUnroundedAtP(P0, taxNow);

  // Kink: gain(P_kink) = E => P_kink = (E + B) / A
  const pKink = A !== 0 ? (E + B) / A : Infinity;
  const netAtKink = netUnroundedAtP(pKink, 0); // just below/at the kink, LTCG tax is still 0

  let pStar: number;
  if (netNow <= netAtKink) {
    // Root is in segment 1 (P <= pKink): net(P) = q*P*(1-totalSlope) - totalFlat = netNow
    pStar = (netNow + sellForm.flat) / (q * (1 - sellForm.slope));
  } else {
    // Root is in segment 2 (P > pKink): net(P) = q*P*(1-totalSlope) - totalFlat
    //                                            - (A*P - B - E) * ltcgRate/100 * (1+cess/100)
    const k = (input.ltcgRatePct / 100) * (1 + input.cessPct / 100);
    // q*(1-totalSlope)*P - k*A*P = netNow + totalFlat - k*(B+E)
    const coeffP = q * (1 - sellForm.slope) - k * A;
    const rhs = netNow + sellForm.flat - k * (B + E);
    pStar = rhs / coeffP;
  }

  return {
    netNowPaise: BigInt(Math.round(netNow)),
    taxIfNowPaise: BigInt(Math.round(taxNow)),
    breakevenPricePaise: pStar,
    dropFraction: (P0 - pStar) / P0,
  };
}
