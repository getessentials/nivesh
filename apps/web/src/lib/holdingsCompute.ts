/**
 * Client-side FIFO lot walk — the SAME `computeRemainingLots` the pipeline uses server-side
 * (packages/engine), so invested/current-value/unrealized-P&L figures shown here can never
 * disagree with the tax engine's own view of a lot (docs/05 holdings view comment: "no SQL
 * aggregate is correct after partial sells").
 */
import { computeRemainingLots, type Lot, type Transaction, type ChargeConfigRow, type AssetClass } from '@niveshetf/engine';
import type { TransactionRow, ChargesConfigRow, UserChargesOverrideRow } from '@/types/db';

export function toEngineTransactions(rows: readonly TransactionRow[]): Transaction[] {
  return rows.map((r) => ({
    id: r.id, side: r.side, qty: r.qty, pricePaise: BigInt(r.price_paise), tradedOn: r.traded_on, createdAt: r.created_at,
  }));
}

export function toEngineChargeConfig(rows: readonly ChargesConfigRow[]): ChargeConfigRow[] {
  return rows.map((r) => ({
    chargeKey: r.charge_key, assetClass: r.asset_class, side: r.side, kind: r.kind, value: Number(r.value),
    taxDeductible: r.tax_deductible, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  }));
}

/** user_charges_overrides has no effective-date columns — always-in-effect once set (docs/05). */
export function toEngineOverrides(rows: readonly UserChargesOverrideRow[]): ChargeConfigRow[] {
  return rows.map((r) => ({
    chargeKey: r.charge_key, assetClass: r.asset_class, side: r.side, kind: r.kind, value: Number(r.value),
    taxDeductible: r.tax_deductible, effectiveFrom: '1900-01-01', effectiveTo: null,
  }));
}

export interface HoldingValuation {
  etfId: number;
  lots: Lot[];
  qty: number;
  investedPaise: bigint;
  currentValuePaise: bigint;
  unrealizedPaise: bigint;
  earliestBuyDate: string | null;
}

/** Remaining lots + invested/current-value/unrealized P&L per ETF, given that ETF's own
 *  transaction history, the resolved charge config, and its latest close price. */
export function valuateHolding(
  etfId: number,
  transactionsForEtf: readonly TransactionRow[],
  assetClass: AssetClass,
  brokerChargeConfigs: readonly ChargeConfigRow[],
  overrides: readonly ChargeConfigRow[],
  latestPricePaise: bigint | null
): HoldingValuation | null {
  const lots = computeRemainingLots(toEngineTransactions(transactionsForEtf), assetClass, brokerChargeConfigs, overrides);
  if (lots.length === 0) return null;

  const qty = lots.reduce((s, l) => s + l.qty, 0);
  const investedPaise = lots.reduce((s, l) => s + BigInt(l.qty) * l.buyPricePaise, 0n);
  const currentValuePaise = latestPricePaise !== null ? BigInt(qty) * latestPricePaise : 0n;
  const earliestBuyDate = lots.map((l) => l.buyDate).sort()[0] ?? null;

  return {
    etfId,
    lots, qty, investedPaise, currentValuePaise,
    unrealizedPaise: currentValuePaise - investedPaise,
    earliestBuyDate,
  };
}
