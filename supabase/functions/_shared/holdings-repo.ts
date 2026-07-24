/** Loads a user's current holdings (remaining FIFO lots per ETF) from `transactions`, using
 *  packages/engine's `computeRemainingLots` — the one place lot math happens, so the pipeline's
 *  view of holdings can never disagree with the sell planner's (docs/04 §1). */
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeRemainingLots, type Lot, type Transaction, type ChargeConfigRow, type AssetClass } from './engine-lib.ts';

export interface HeldPosition {
  etfId: number;
  assetClass: AssetClass;
  underlyingIndex: string;
  lots: Lot[];
}

async function loadBrokerProfile(supabase: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await supabase.from('profiles').select('broker_profile').eq('user_id', userId).single();
  if (error) throw new Error(`failed to load profile for user ${userId}: ${error.message}`);
  return (data as { broker_profile: string }).broker_profile;
}

async function loadBrokerChargeConfig(supabase: SupabaseClient, brokerProfile: string): Promise<ChargeConfigRow[]> {
  const { data, error } = await supabase.from('charges_config').select('*').eq('broker_profile', brokerProfile);
  if (error) throw new Error(`failed to load charges_config for broker profile ${brokerProfile}: ${error.message}`);
  return (data as Array<{
    charge_key: string; asset_class: AssetClass; side: 'buy' | 'sell' | 'both'; kind: 'pct' | 'flat_paise';
    value: number; tax_deductible: boolean; effective_from: string; effective_to: string | null;
  }>).map((r) => ({
    chargeKey: r.charge_key, assetClass: r.asset_class, side: r.side, kind: r.kind, value: r.value,
    taxDeductible: r.tax_deductible, effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
  }));
}

/** user_charges_overrides has no effective-date columns — an override is always in effect once
 *  set (docs/05), so it's mapped to an always-matching sentinel range for resolveChargeRows. */
async function loadUserChargeOverrides(supabase: SupabaseClient, userId: string): Promise<ChargeConfigRow[]> {
  const { data, error } = await supabase.from('user_charges_overrides').select('*').eq('user_id', userId);
  if (error) throw new Error(`failed to load user_charges_overrides for user ${userId}: ${error.message}`);
  return (data as Array<{
    charge_key: string; asset_class: AssetClass; side: 'buy' | 'sell' | 'both'; kind: 'pct' | 'flat_paise';
    value: number; tax_deductible: boolean;
  }>).map((r) => ({
    chargeKey: r.charge_key, assetClass: r.asset_class, side: r.side, kind: r.kind, value: r.value,
    taxDeductible: r.tax_deductible, effectiveFrom: '1900-01-01', effectiveTo: null,
  }));
}

async function loadTransactionsByEtf(supabase: SupabaseClient, userId: string): Promise<Map<number, Transaction[]>> {
  const { data, error } = await supabase
    .from('transactions')
    .select('id, etf_id, side, qty, price_paise, traded_on, created_at')
    .eq('user_id', userId);
  if (error) throw new Error(`failed to load transactions for user ${userId}: ${error.message}`);

  const byEtf = new Map<number, Transaction[]>();
  for (const row of data as Array<{ id: string; etf_id: number; side: 'buy' | 'sell'; qty: number; price_paise: string; traded_on: string; created_at: string }>) {
    const arr = byEtf.get(row.etf_id) ?? [];
    arr.push({ id: row.id, side: row.side, qty: row.qty, pricePaise: BigInt(row.price_paise), tradedOn: row.traded_on, createdAt: row.created_at });
    byEtf.set(row.etf_id, arr);
  }
  return byEtf;
}

/** Current holdings across every ETF the user has ever transacted, net of all historical sells
 *  (docs/05 `holdings` view's derivation, replicated here via the engine so tax/feedback numbers
 *  can never diverge from the qty the view shows). Only ETFs with qty > 0 remaining are returned. */
export async function loadCurrentHoldings(supabase: SupabaseClient, userId: string): Promise<HeldPosition[]> {
  const brokerProfile = await loadBrokerProfile(supabase, userId);
  const [brokerConfig, overrides, txnsByEtf] = await Promise.all([
    loadBrokerChargeConfig(supabase, brokerProfile),
    loadUserChargeOverrides(supabase, userId),
    loadTransactionsByEtf(supabase, userId),
  ]);
  if (txnsByEtf.size === 0) return [];

  const etfIds = [...txnsByEtf.keys()];
  const { data: etfRows, error: etfErr } = await supabase.from('etfs').select('id, asset_class, underlying_index').in('id', etfIds);
  if (etfErr) throw new Error(`failed to load etfs for holdings: ${etfErr.message}`);
  const etfMeta = new Map((etfRows as Array<{ id: number; asset_class: AssetClass; underlying_index: string }>).map((r) => [r.id, r]));

  const positions: HeldPosition[] = [];
  for (const [etfId, txns] of txnsByEtf) {
    const meta = etfMeta.get(etfId);
    if (!meta) continue;
    const lots = computeRemainingLots(txns, meta.asset_class, brokerConfig, overrides);
    if (lots.length > 0) positions.push({ etfId, assetClass: meta.asset_class, underlyingIndex: meta.underlying_index, lots });
  }
  return positions;
}
