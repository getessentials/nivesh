/**
 * FY exemption-ledger reconstruction and FY report aggregation (docs/04 §2.1). The equity LTCG
 * exemption (₹1.25L) is consumed chronologically across ALL of a user's equity sells within one
 * FY, regardless of which ETF — so this replays every real equity sell in order, computing each
 * one's own "lots immediately before it" via `computeRemainingLots` (the same replay the pipeline
 * and holdings view use), threading the running exemption balance from one sell to the next
 * exactly as `computeFySellSequence` does, but across ETFs rather than within one.
 */
import {
  computeRemainingLots, computeSellPlan, classifySliceLoss, computeSetOffSuggestion, resolveTaxConfig,
  type Transaction, type ChargeConfigRow, type TaxConfigRow, type SellPlanResult, type AssetClass,
} from '@niveshetf/engine';
import type { TransactionRow } from '@/types/db';
import { toEngineTransactions } from './holdingsCompute';

// ₹1.25L (docs/04 §2.1) — used ONLY as a display fallback while tax_config hasn't loaded yet.
// The real, effective-dated value always comes from `taxConfigs` via `resolveEquityExemptionPaise`
// below; hardcoding this as the ledger size would silently ignore future Budget-driven changes to
// tax_config's own ltcg_exemption_paise (docs/04 header: "rules ... will change again").
const EQUITY_LTCG_EXEMPTION_PAISE_FALLBACK = 12_500_000n;

/** Resolves the equity LTCG exemption pool size from `tax_config` as of `fyEnd` (the ledger has
 *  one size for the whole FY; equity's acquired_from/to are null in the current seed, so any
 *  in-FY sell date resolves the same single row). Falls back to the constant above only if
 *  `taxConfigs` hasn't loaded yet (empty array) or the FY predates any seeded row. */
function resolveEquityExemptionPaise(taxConfigs: readonly TaxConfigRow[], fyEnd: string): bigint {
  try {
    return resolveTaxConfig(taxConfigs, 'equity', fyEnd, fyEnd).ltcgExemptionPaise;
  } catch {
    return EQUITY_LTCG_EXEMPTION_PAISE_FALLBACK;
  }
}

function chronologicalOrder(a: Transaction, b: Transaction): number {
  if (a.tradedOn !== b.tradedOn) return a.tradedOn < b.tradedOn ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface RealizedSellResult {
  transactionId: string;
  etfId: number;
  tradedOn: string;
  result: SellPlanResult;
}

/**
 * Replays every REAL equity sell within [fyStart, fyEnd] in chronological order (across all
 * ETFs), returning each one's full SellPlanResult and the exemption balance remaining after the
 * FY's realized sells (before any hypothetical the sell planner appends).
 */
export function replayFyEquitySells(
  allTransactionsByEtf: Map<number, TransactionRow[]>,
  etfAssetClassById: Map<number, AssetClass>,
  fyStart: string,
  fyEnd: string,
  usedElsewherePaise: bigint,
  taxConfigs: readonly TaxConfigRow[],
  chargeConfigs: readonly ChargeConfigRow[],
  overrides: readonly ChargeConfigRow[],
  slabPct: number
): { realizedSells: RealizedSellResult[]; exemptionRemainingPaise: bigint } {
  const realizedSells: RealizedSellResult[] = [];
  let exemptionRemaining = resolveEquityExemptionPaise(taxConfigs, fyEnd) - usedElsewherePaise;
  if (exemptionRemaining < 0n) exemptionRemaining = 0n;

  const equitySellsThisFy: Array<{ etfId: number; txn: Transaction }> = [];
  for (const [etfId, rows] of allTransactionsByEtf) {
    if (etfAssetClassById.get(etfId) !== 'equity') continue;
    for (const t of toEngineTransactions(rows)) {
      if (t.side === 'sell' && t.tradedOn >= fyStart && t.tradedOn <= fyEnd) equitySellsThisFy.push({ etfId, txn: t });
    }
  }
  equitySellsThisFy.sort((a, b) => chronologicalOrder(a.txn, b.txn));

  for (const { etfId, txn } of equitySellsThisFy) {
    const etfTxns = toEngineTransactions(allTransactionsByEtf.get(etfId) ?? []);
    const before = etfTxns.filter((t) => chronologicalOrder(t, txn) < 0);
    const lotsBefore = computeRemainingLots(before, 'equity', chargeConfigs, overrides);

    const result = computeSellPlan({
      assetClass: 'equity', ltcgMonthsOverride: null, sellDate: txn.tradedOn, sellPricePaise: txn.pricePaise,
      sellQty: txn.qty, currentLots: lotsBefore, taxConfigs, brokerChargeConfigs: chargeConfigs, chargeOverrides: overrides,
      slabPct, exemptionRemainingPaise: exemptionRemaining,
    });
    exemptionRemaining -= result.exemptionConsumedPaise;
    realizedSells.push({ transactionId: txn.id, etfId, tradedOn: txn.tradedOn, result });
  }

  return { realizedSells, exemptionRemainingPaise: exemptionRemaining };
}

export interface FyReportSummary {
  stcgGainPaise: bigint;
  ltcgGainPaise: bigint;
  totalTaxPaise: bigint;
  exemptionUsedPaise: bigint;
  exemptionRemainingPaise: bigint;
  setOff: ReturnType<typeof computeSetOffSuggestion>;
}

export function summarizeFyReport(realizedSells: RealizedSellResult[], exemptionRemainingPaise: bigint): FyReportSummary {
  let stcgGain = 0n, ltcgGain = 0n, totalTax = 0n, exemptionUsed = 0n, stcl = 0n, ltcl = 0n;
  for (const { result } of realizedSells) {
    for (const slice of result.slices) {
      const loss = classifySliceLoss(slice.taxableGainPaise, slice.classification);
      stcl += loss.stclPaise;
      ltcl += loss.ltclPaise;
      if (slice.taxableGainPaise > 0n) {
        if (slice.classification === 'STCG') stcgGain += slice.taxableGainPaise;
        else ltcgGain += slice.taxableGainPaise;
      }
    }
    totalTax += result.totalTaxWithCessPaise;
    exemptionUsed += result.exemptionConsumedPaise;
  }
  const setOff = computeSetOffSuggestion(stcl, ltcl, stcgGain, ltcgGain);
  return { stcgGainPaise: stcgGain, ltcgGainPaise: ltcgGain, totalTaxPaise: totalTax, exemptionUsedPaise: exemptionUsed, exemptionRemainingPaise, setOff };
}
