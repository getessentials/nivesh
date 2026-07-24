/** Shared types for the tax/charges engine (docs/04, docs/05). All dates are 'YYYY-MM-DD'. */

export type AssetClass = 'equity' | 'gold' | 'silver' | 'debt' | 'intl';

export interface TaxConfigRow {
  assetClass: AssetClass;
  effectiveFrom: string;
  effectiveTo: string | null;
  acquiredFrom: string | null;
  acquiredTo: string | null;
  stcgMode: 'flat' | 'slab';
  stcgRatePct: number | null;
  ltcgMonths: number;
  ltcgRatePct: number;
  ltcgExemptionPaise: bigint;
  cessPct: number;
}

export type ChargeSide = 'buy' | 'sell' | 'both';
export type ChargeKind = 'pct' | 'flat_paise';

export interface ChargeConfigRow {
  chargeKey: string;
  assetClass: AssetClass;
  side: ChargeSide;
  kind: ChargeKind;
  /** pct: a percentage (0.00297 = 0.00297%). flat_paise: an integer paise amount. */
  value: number;
  taxDeductible: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface Lot {
  /** the id of the originating buy transaction */
  id: string;
  /** CURRENT remaining quantity (decreases as the lot is partially sold) */
  qty: number;
  buyPricePaise: bigint;
  buyDate: string;
  /** ISO timestamp, for same-day FIFO/exemption tie-breaks (docs/04 §1, §2.1). */
  createdAt: string;
  /**
   * CURRENT remaining deductible buy-side charges (decreases in lockstep with `qty` as the lot
   * is partially sold — NOT a fixed "original" figure recomputed by ratio each time). Real
   * brokerage/charges were paid ONCE on the full original order (docs/04 §3); when a lot is sold
   * across MULTIPLE separate transactions over time, apportioning each sale against the
   * ORIGINAL qty/charges independently drifts the total by rounding (verified: a 100-unit lot's
   * 521 paisa split 50/50 across two separate sells summed to 522, not 521). Apportioning
   * against the CURRENT remainder instead, and decrementing it as each sale is replayed
   * (fifo.ts), guarantees exact conservation: the very last sale of what's left always takes
   * the exact remainder with no rounding, so the running total can never drift from the
   * original no matter how many transactions span the lot's lifetime.
   */
  deductibleBuyChargesPaise: bigint;
}

export interface Transaction {
  id: string;
  side: 'buy' | 'sell';
  qty: number;
  pricePaise: bigint;
  tradedOn: string;
  /** ISO timestamp — tie-breaks same-day transactions (docs/04 §1, §2.1). */
  createdAt: string;
}

export interface FifoSlice {
  lotId: string;
  /** units taken from this lot for this slice */
  qty: number;
  buyPricePaise: bigint;
  buyDate: string;
  /** the lot's remaining qty immediately BEFORE this slice was drawn (the apportionment
   *  denominator — see Lot.deductibleBuyChargesPaise for why this must be the current
   *  remainder, not the lot's original purchase qty). */
  qtyBeforeSlice: number;
  /** the lot's remaining deductible buy charges immediately BEFORE this slice was drawn. */
  deductibleBuyChargesBeforeSlice: bigint;
}

export interface ChargeLineItem {
  chargeKey: string;
  amountPaise: bigint;
  taxDeductible: boolean;
}

export interface LegCharges {
  lineItems: ChargeLineItem[];
  totalPaise: bigint;
  deductiblePaise: bigint;
}
