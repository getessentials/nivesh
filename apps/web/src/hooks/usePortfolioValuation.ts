import { useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  useGetTransactionsQuery, useGetEtfsQuery, useGetUserChargesOverridesQuery, useGetProfileQuery,
  useGetChargesConfigQuery,
} from '@/store/api';
import { supabase } from '@/lib/supabase';
import { useEffect, useState } from 'react';
import { toEngineChargeConfig, toEngineOverrides, valuateHolding, type HoldingValuation } from '@/lib/holdingsCompute';
import type { EtfRow } from '@/types/db';

export interface PortfolioValuation {
  isLoading: boolean;
  holdings: Array<HoldingValuation & { etf: EtfRow }>;
  totalInvestedPaise: bigint;
  totalCurrentValuePaise: bigint;
  totalUnrealizedPaise: bigint;
}

/** Latest close price per ETF id — a small dedicated fetch since it's a "most recent row per
 *  group" query PostgREST can't express as a single filter. */
function useLatestPrices(etfIds: number[]): { prices: Map<number, bigint>; isLoading: boolean } {
  const [prices, setPrices] = useState<Map<number, bigint>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const key = etfIds.slice().sort().join(',');
  useEffect(() => {
    if (etfIds.length === 0) { setPrices(new Map()); setIsLoading(false); return; }
    let cancelled = false;
    setIsLoading(true);
    supabase
      .from('etf_prices')
      .select('etf_id, d, close_paise')
      .in('etf_id', etfIds)
      .order('d', { ascending: false })
      .then(({ data }) => {
        if (cancelled) return;
        const latest = new Map<number, bigint>();
        for (const row of (data ?? []) as Array<{ etf_id: number; close_paise: string }>) {
          if (!latest.has(row.etf_id)) latest.set(row.etf_id, BigInt(row.close_paise));
        }
        setPrices(latest);
        setIsLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { prices, isLoading };
}

/** Computes current holdings valuations client-side via the same FIFO engine the pipeline uses
 *  (docs/05: "no SQL aggregate is correct after partial sells"). */
export function usePortfolioValuation(): PortfolioValuation {
  const { session } = useAuth();
  const userId = session!.user.id;

  const { data: profile } = useGetProfileQuery(userId);
  const { data: transactions, isLoading: txnsLoading } = useGetTransactionsQuery(userId);
  const { data: etfs, isLoading: etfsLoading } = useGetEtfsQuery();
  const { data: chargesConfig, isLoading: chargesLoading } = useGetChargesConfigQuery(profile?.broker_profile ?? 'discount_default', {
    skip: !profile,
  });
  const { data: overrides, isLoading: overridesLoading } = useGetUserChargesOverridesQuery(userId);

  const heldEtfIds = useMemo(() => {
    if (!transactions) return [];
    const byEtf = new Map<number, number>();
    for (const t of transactions) byEtf.set(t.etf_id, (byEtf.get(t.etf_id) ?? 0) + (t.side === 'buy' ? t.qty : -t.qty));
    return [...byEtf.entries()].filter(([, qty]) => qty > 0).map(([id]) => id);
  }, [transactions]);

  const { prices, isLoading: pricesLoading } = useLatestPrices(heldEtfIds);

  const isLoading = txnsLoading || etfsLoading || chargesLoading || overridesLoading || pricesLoading || !profile;

  return useMemo(() => {
    if (isLoading || !transactions || !etfs || !chargesConfig) {
      return { isLoading: true, holdings: [], totalInvestedPaise: 0n, totalCurrentValuePaise: 0n, totalUnrealizedPaise: 0n };
    }
    const etfById = new Map(etfs.map((e) => [e.id, e]));
    const txnsByEtf = new Map<number, typeof transactions>();
    for (const t of transactions) {
      const arr = txnsByEtf.get(t.etf_id) ?? [];
      arr.push(t);
      txnsByEtf.set(t.etf_id, arr);
    }

    const engineCharges = toEngineChargeConfig(chargesConfig);
    const engineOverrides = toEngineOverrides(overrides ?? []);

    const holdings: Array<HoldingValuation & { etf: EtfRow }> = [];
    for (const [etfId, txns] of txnsByEtf) {
      const etf = etfById.get(etfId);
      if (!etf) continue;
      const valuation = valuateHolding(etfId, txns, etf.asset_class, engineCharges, engineOverrides, prices.get(etfId) ?? null);
      if (valuation) holdings.push({ ...valuation, etf });
    }
    holdings.sort((a, b) => Number(b.currentValuePaise - a.currentValuePaise));

    const totalInvestedPaise = holdings.reduce((s, h) => s + h.investedPaise, 0n);
    const totalCurrentValuePaise = holdings.reduce((s, h) => s + h.currentValuePaise, 0n);
    return {
      isLoading: false, holdings, totalInvestedPaise, totalCurrentValuePaise,
      totalUnrealizedPaise: totalCurrentValuePaise - totalInvestedPaise,
    };
  }, [isLoading, transactions, etfs, chargesConfig, overrides, prices]);
}
