/**
 * Sell-planner tax computation (docs/04 §2-3, docs/08 §6). Given a sell against the current
 * FIFO lots, produces a per-slice breakdown: classification (STCG/LTCG), recomputed buy/sell
 * charges, taxable gain, tax+cess (floored at 0), and net proceeds — reproducing docs/04 E1-E4
 * to the paisa.
 */
import { sliceFifo, monthsHeld, apportionLotCharges } from './fifo.ts';
import { resolveTaxConfig, resolveChargeRows } from './config-resolution.ts';
import { computeLegCharges } from './charges.ts';
import { apportionLargestRemainder, divRoundHalfUp, scaleDecimalToBigInt } from './rounding.ts';
import type { AssetClass, ChargeConfigRow, Lot, TaxConfigRow } from './types.ts';

export interface SellPlanRequest {
  assetClass: AssetClass;
  /** etfs.ltcg_months override; null means "use the resolved tax_config row's ltcgMonths". */
  ltcgMonthsOverride: number | null;
  sellDate: string;
  sellPricePaise: bigint;
  sellQty: number;
  currentLots: readonly Lot[];
  taxConfigs: readonly TaxConfigRow[];
  brokerChargeConfigs: readonly ChargeConfigRow[];
  chargeOverrides?: readonly ChargeConfigRow[];
  /** user's marginal slab rate, for STCG-slab asset classes (gold/silver/debt) — not in tax_config. */
  slabPct: number;
  /** equity LTCG exemption remaining at the START of this sell (docs/04 §2.1 FY ledger),
   *  already netted for external usage (fy_exemption_inputs) and any earlier sells this FY.
   *  Ignored for non-equity asset classes. */
  exemptionRemainingPaise: bigint;
}

export interface SliceResult {
  lotId: string;
  qty: number;
  buyDate: string;
  buyPricePaise: bigint;
  classification: 'STCG' | 'LTCG';
  monthsHeld: number;
  /** this slice's apportioned share of the lot's real, once-paid deductible buy charges
   *  (docs/04 §3) — not a fresh recomputation on the slice's own quantity. */
  buyDeductibleChargesPaise: bigint;
  sellChargesPaise: bigint;
  sellDeductibleChargesPaise: bigint;
  effectiveCostPaise: bigint;
  netConsiderationPaise: bigint;
  taxableGainPaise: bigint;
  exemptionUsedPaise: bigint;
  taxWithCessPaise: bigint;
  netProceedsPaise: bigint;
}

export interface SellPlanResult {
  slices: SliceResult[];
  totalSellChargesPaise: bigint;
  totalTaxWithCessPaise: bigint;
  totalNetProceedsPaise: bigint;
  exemptionConsumedPaise: bigint;
}

/** `max(0, gain) * ratePct/100 * (1+cessPct/100)`, computed as one unrounded expression and
 *  rounded half-up ONCE (docs/08 §6 rule 5). Loss slices (gain <= 0) pay exactly 0 tax. */
export function taxWithCess(gainTaxablePaise: bigint, ratePct: number, cessPct: number): bigint {
  const floored = gainTaxablePaise > 0n ? gainTaxablePaise : 0n;
  if (floored === 0n) return 0n;
  const rateScaled = scaleDecimalToBigInt(ratePct, 2); // ratePct is numeric(5,2)
  const combinedScaled = scaleDecimalToBigInt(100 + cessPct, 2); // cessPct is numeric(5,2)
  return divRoundHalfUp(floored * rateScaled * combinedScaled, 10n ** 8n);
}

/** Apportions each of an order's charge line items pro-rata by slice consideration
 *  (largest-remainder, docs/08 §6 rule 4) so per-slice totals AND deductible subtotals both sum
 *  exactly to the order's real totals — apportioning per line item (not the aggregate) keeps
 *  the deductible/non-deductible split exact too. */
function apportionSellChargesToSlices(
  sellLineItems: ReturnType<typeof computeLegCharges>['lineItems'],
  sliceWeights: bigint[]
): { totalPerSlice: bigint[]; deductiblePerSlice: bigint[] } {
  const totalPerSlice = sliceWeights.map(() => 0n);
  const deductiblePerSlice = sliceWeights.map(() => 0n);
  for (const item of sellLineItems) {
    const shares = apportionLargestRemainder(item.amountPaise, sliceWeights);
    for (let i = 0; i < shares.length; i++) {
      totalPerSlice[i] = totalPerSlice[i]! + shares[i]!;
      if (item.taxDeductible) deductiblePerSlice[i] = deductiblePerSlice[i]! + shares[i]!;
    }
  }
  return { totalPerSlice, deductiblePerSlice };
}

export function computeSellPlan(req: SellPlanRequest): SellPlanResult {
  const fifoSlices = sliceFifo(req.currentLots, req.sellQty);

  const sellChargeRows = resolveChargeRows(req.brokerChargeConfigs, req.assetClass, req.sellDate, req.chargeOverrides);
  const sellConsiderationPaise = BigInt(req.sellQty) * req.sellPricePaise;
  const sellLegCharges = computeLegCharges(sellChargeRows, 'sell', sellConsiderationPaise);

  const sliceWeights = fifoSlices.map((s) => BigInt(s.qty) * req.sellPricePaise);
  const { totalPerSlice: sellChargesPerSlice, deductiblePerSlice: sellDeductiblePerSlice } =
    apportionSellChargesToSlices(sellLegCharges.lineItems, sliceWeights);

  let exemptionRemaining = req.exemptionRemainingPaise;
  const slices: SliceResult[] = [];

  fifoSlices.forEach((fs, i) => {
    const taxConfig = resolveTaxConfig(req.taxConfigs, req.assetClass, req.sellDate, fs.buyDate);
    const ltcgMonths = req.ltcgMonthsOverride ?? taxConfig.ltcgMonths;
    const held = monthsHeld(fs.buyDate, req.sellDate);
    const classification: 'STCG' | 'LTCG' = held >= ltcgMonths ? 'LTCG' : 'STCG';

    const buyConsiderationPaise = BigInt(fs.qty) * fs.buyPricePaise;
    const buyDeductibleChargesPaise = apportionLotCharges(
      fs.deductibleBuyChargesBeforeSlice, fs.qty, fs.qtyBeforeSlice
    );

    const effectiveCostPaise = buyConsiderationPaise + buyDeductibleChargesPaise;
    const netConsiderationPaise = sliceWeights[i]! - sellDeductiblePerSlice[i]!;
    const taxableGainPaise = netConsiderationPaise - effectiveCostPaise;

    let exemptionUsedPaise = 0n;
    let gainAfterExemption = taxableGainPaise;
    if (classification === 'LTCG' && taxableGainPaise > 0n && taxConfig.ltcgExemptionPaise > 0n) {
      exemptionUsedPaise = taxableGainPaise < exemptionRemaining ? taxableGainPaise : exemptionRemaining;
      exemptionRemaining -= exemptionUsedPaise;
      gainAfterExemption = taxableGainPaise - exemptionUsedPaise;
    }

    const ratePct = classification === 'LTCG'
      ? taxConfig.ltcgRatePct
      : (taxConfig.stcgMode === 'flat' ? taxConfig.stcgRatePct! : req.slabPct);
    const tax = taxWithCess(gainAfterExemption, ratePct, taxConfig.cessPct);

    const netProceedsPaise = sliceWeights[i]! - sellChargesPerSlice[i]! - tax;

    slices.push({
      lotId: fs.lotId, qty: fs.qty, buyDate: fs.buyDate, buyPricePaise: fs.buyPricePaise,
      classification, monthsHeld: held,
      buyDeductibleChargesPaise,
      sellChargesPaise: sellChargesPerSlice[i]!, sellDeductibleChargesPaise: sellDeductiblePerSlice[i]!,
      effectiveCostPaise, netConsiderationPaise, taxableGainPaise,
      exemptionUsedPaise, taxWithCessPaise: tax, netProceedsPaise,
    });
  });

  return {
    slices,
    totalSellChargesPaise: sellLegCharges.totalPaise,
    totalTaxWithCessPaise: slices.reduce((s, x) => s + x.taxWithCessPaise, 0n),
    totalNetProceedsPaise: slices.reduce((s, x) => s + x.netProceedsPaise, 0n),
    exemptionConsumedPaise: slices.reduce((s, x) => s + x.exemptionUsedPaise, 0n),
  };
}

// ===== Loss set-off (docs/04 §2.5, display-only in v1) =====

export interface LossClassification {
  /** short-term capital loss magnitude (>= 0) */
  stclPaise: bigint;
  /** long-term capital loss magnitude (>= 0) */
  ltclPaise: bigint;
}

/** Classifies a slice's taxable gain into STCL/LTCL for FY-report set-off display (docs/04
 *  §2.5). A non-negative gain classifies as neither (it's a gain, not a loss). */
export function classifySliceLoss(taxableGainPaise: bigint, classification: 'STCG' | 'LTCG'): LossClassification {
  if (taxableGainPaise >= 0n) return { stclPaise: 0n, ltclPaise: 0n };
  const loss = -taxableGainPaise;
  return classification === 'STCG' ? { stclPaise: loss, ltclPaise: 0n } : { stclPaise: 0n, ltclPaise: loss };
}

export interface SetOffSuggestion {
  stclAppliedToStcgPaise: bigint;
  stclAppliedToLtcgPaise: bigint;
  ltclAppliedToLtcgPaise: bigint;
  stclCarriedForwardPaise: bigint;
  ltclCarriedForwardPaise: bigint;
}

/**
 * FY-level set-off suggestion (docs/04 §2.5, display-only — "8-year carry-forward if ITR filed
 * on time" is a filing-status fact outside this pure function's scope, not computed here): STCL
 * offsets STCG then any leftover STCG-capacity spills to LTCG; LTCL offsets LTCG only. Whatever
 * isn't absorbed this FY is reported as carried forward. All inputs are non-negative magnitudes
 * (an FY with a net STCG/LTCG LOSS passes 0 for that gain figure, not a negative number).
 */
export function computeSetOffSuggestion(
  stclAvailablePaise: bigint,
  ltclAvailablePaise: bigint,
  stcgGainPaise: bigint,
  ltcgGainPaise: bigint
): SetOffSuggestion {
  let stcl = stclAvailablePaise;
  let ltcl = ltclAvailablePaise;

  const stclAppliedToStcgPaise = stcl < stcgGainPaise ? stcl : stcgGainPaise;
  stcl -= stclAppliedToStcgPaise;

  const stclAppliedToLtcgPaise = stcl < ltcgGainPaise ? stcl : ltcgGainPaise;
  stcl -= stclAppliedToLtcgPaise;

  const remainingLtcgAfterStcl = ltcgGainPaise - stclAppliedToLtcgPaise;
  const ltclAppliedToLtcgPaise = ltcl < remainingLtcgAfterStcl ? ltcl : remainingLtcgAfterStcl;
  ltcl -= ltclAppliedToLtcgPaise;

  return {
    stclAppliedToStcgPaise, stclAppliedToLtcgPaise, ltclAppliedToLtcgPaise,
    stclCarriedForwardPaise: stcl, ltclCarriedForwardPaise: ltcl,
  };
}

// ===== Cross-sell exemption sequencing within one FY (docs/04 §2.1) =====

export interface FySellEvent {
  id: string;
  /** ISO timestamp — same-day tie-break, alongside `id` (docs/04 §2.1). */
  createdAt: string;
  /** exemptionRemainingPaise on this request is IGNORED — the sequencer supplies it. */
  request: SellPlanRequest;
}

/**
 * Sequences multiple sells within one FY (docs/04 §2.1: exemption is "consumed chronologically
 * by sell date within the FY, same-day ties broken by transaction created_at, then id"),
 * threading each sell's ending exemption-remaining into the next sell's starting point.
 * `initialExemptionRemainingPaise` already nets `fy_exemption_inputs` (external usage this FY).
 * Per docs/04 §2.1 ("sell-planner hypotheticals apply AFTER all realized sells"), the CALLER is
 * responsible for placing hypothetical events after every realized event for the same date —
 * this function only sorts by (sellDate, createdAt, id), it does not itself know which events
 * are hypothetical.
 */
export function computeFySellSequence(
  events: readonly FySellEvent[],
  initialExemptionRemainingPaise: bigint
): SellPlanResult[] {
  const ordered = [...events].sort((a, b) => {
    const da = a.request.sellDate, db = b.request.sellDate;
    if (da !== db) return da < db ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  let exemptionRemaining = initialExemptionRemainingPaise;
  const results: SellPlanResult[] = [];
  for (const event of ordered) {
    const result = computeSellPlan({ ...event.request, exemptionRemainingPaise: exemptionRemaining });
    exemptionRemaining -= result.exemptionConsumedPaise;
    results.push(result);
  }
  return results;
}
