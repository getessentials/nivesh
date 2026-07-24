import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts';
import { supabase } from '@/lib/supabase';
import { rebaseTo100, mergeSeriesForChart, type SeriesPoint } from '@/lib/chartMath';
import type { HoldingValuation } from '@/lib/holdingsCompute';
import type { EtfRow } from '@/types/db';

/**
 * Portfolio value vs "what if all-in Nifty 50 (TRI)" (docs/01 §3.3b). Approximation, flagged
 * explicitly: portfolio value is CURRENT holdings' quantities applied backward over each ETF's own
 * price history — it does not replay historical buy/sell timing, so it understates/overstates
 * periods before a holding's current quantity was reached. A precise version would need a full
 * day-by-day lot replay; this is a reasonable v1 visualization, not a lot-accurate ledger.
 */
export function PortfolioCounterfactualChart({ holdings }: { holdings: Array<HoldingValuation & { etf: EtfRow }> }) {
  const [chartData, setChartData] = useState<Array<{ d: string } & Record<string, number | string>> | null>(null);

  const sinceDate = holdings.map((h) => h.earliestBuyDate).filter((d): d is string => d !== null).sort()[0] ?? null;

  useEffect(() => {
    if (!sinceDate || holdings.length === 0) return;
    let cancelled = false;

    async function load() {
      const [priceResults, triRes] = await Promise.all([
        Promise.all(holdings.map((h) => supabase.from('etf_prices').select('d, close_paise').eq('etf_id', h.etfId).gte('d', sinceDate!).order('d'))),
        supabase.from('index_tri').select('d, value').eq('index_name', 'NIFTY 50 TRI').gte('d', sinceDate!).order('d'),
      ]);
      if (cancelled) return;

      const dateSet = new Set<string>();
      const pricesByEtf = new Map<number, Map<string, number>>();
      holdings.forEach((h, i) => {
        const rows = (priceResults[i]!.data as Array<{ d: string; close_paise: string }>) ?? [];
        const map = new Map(rows.map((r) => [r.d, Number(r.close_paise)]));
        pricesByEtf.set(h.etfId, map);
        for (const d of map.keys()) dateSet.add(d);
      });

      // Forward-fill: a date gap in one ETF's price history (holiday mismatch, listing lag) would
      // otherwise silently drop that holding from the sum for that date, producing an artificial
      // dip/jump with no signal. Carry the last known price forward per-ETF instead; a holding
      // that hasn't started trading yet at all is still excluded (no price seen so far).
      const lastKnownPrice = new Map<number, number>();
      const portfolioSeries: SeriesPoint[] = [...dateSet].sort().map((d) => {
        let value = 0;
        let anyPrice = false;
        for (const h of holdings) {
          const price = pricesByEtf.get(h.etfId)?.get(d);
          if (price !== undefined) lastKnownPrice.set(h.etfId, price);
          const effectivePrice = lastKnownPrice.get(h.etfId);
          if (effectivePrice !== undefined) { value += h.qty * effectivePrice; anyPrice = true; }
        }
        return { d, value: anyPrice ? value : 0, anyPrice };
      }).filter((p) => p.anyPrice).map(({ d, value }) => ({ d, value }));

      const triSeries: SeriesPoint[] = ((triRes.data as Array<{ d: string; value: string }>) ?? []).map((r) => ({ d: r.d, value: Number(r.value) }));

      setChartData(mergeSeriesForChart({
        'Your portfolio (approx.)': rebaseTo100(portfolioSeries, sinceDate!),
        'All-in Nifty 50 (TRI)': rebaseTo100(triSeries, sinceDate!),
      }));
    }
    load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sinceDate, holdings.map((h) => `${h.etfId}:${h.qty}`).join(',')]);

  if (!sinceDate) return <p className="text-sm text-muted-foreground">No holdings to chart yet.</p>;
  if (!chartData) return <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">Loading chart…</div>;

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="d" tick={{ fontSize: 11 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="Your portfolio (approx.)" stroke="var(--color-chart-1)" dot={false} strokeWidth={1.75} />
          <Line type="monotone" dataKey="All-in Nifty 50 (TRI)" stroke="var(--color-chart-2)" dot={false} strokeWidth={1.75} strokeDasharray="4 3" />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-muted-foreground mt-2">
        Approximation: uses today's holding quantities applied across each ETF's own price history, not a full
        historical lot replay; gaps in a single ETF's price history are forward-filled from its last known price.
      </p>
    </div>
  );
}
