import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid, ReferenceDot } from 'recharts';
import { supabase } from '@/lib/supabase';
import { rebaseTo100, mergeSeriesForChart, type SeriesPoint } from '@/lib/chartMath';
import type { HoldingValuation } from '@/lib/holdingsCompute';
import type { EtfRow, IndexRow } from '@/types/db';

const LINE_COLORS = ['var(--color-chart-1)', 'var(--color-chart-2)', 'var(--color-chart-3)', 'var(--color-chart-4)', 'var(--color-chart-5)'];

interface Props {
  holding: HoldingValuation;
  etf: EtfRow;
  indices: IndexRow[];
  allEtfs: EtfRow[];
}

/** Holding (price) vs benchmark (TRI, or nav_proxy) vs up to 3 rival ETFs (NAV) on the same
 *  index, normalized to 100 at the earliest open lot's buy date, with per-lot buy markers
 *  (docs/01 §3.3, docs/08 §3 basis labeling). */
export function HoldingComparisonChart({ holding, etf, indices, allEtfs }: Props) {
  const [chartData, setChartData] = useState<Array<{ d: string } & Record<string, number | string>> | null>(null);
  const sinceDate = holding.earliestBuyDate;

  useEffect(() => {
    if (!sinceDate) return;
    let cancelled = false;

    async function load() {
      const indexMeta = indices.find((i) => i.name === etf.underlying_index);
      const rivals = allEtfs.filter((e) => e.underlying_index === etf.underlying_index && e.id !== etf.id).slice(0, 3);

      const [priceRes, benchmarkRes, ...rivalResList] = await Promise.all([
        supabase.from('etf_prices').select('d, close_paise').eq('etf_id', etf.id).gte('d', sinceDate!).order('d'),
        indexMeta?.tri_source === 'nav_proxy' && indexMeta.proxy_etf_id
          ? supabase.from('etf_navs').select('d, nav_paise').eq('etf_id', indexMeta.proxy_etf_id).gte('d', sinceDate!).order('d')
          : supabase.from('index_tri').select('d, value').eq('index_name', etf.underlying_index).gte('d', sinceDate!).order('d'),
        ...rivals.map((r) => supabase.from('etf_navs').select('d, nav_paise').eq('etf_id', r.id).gte('d', sinceDate!).order('d')),
      ]);
      if (cancelled) return;

      const priceSeries: SeriesPoint[] = (priceRes.data as Array<{ d: string; close_paise: string }> ?? []).map((r) => ({ d: r.d, value: Number(r.close_paise) }));
      const benchmarkSeries: SeriesPoint[] = (benchmarkRes.data as Array<{ d: string; value?: string; nav_paise?: string }> ?? []).map((r) => ({
        d: r.d, value: Number(r.value ?? r.nav_paise),
      }));

      // docs/03 §6: nav_proxy benchmark series must be labeled "not TRI" wherever displayed — it's
      // an ETF's own NAV standing in for the index, not the index's total-return series itself.
      const benchmarkLabel = indexMeta?.tri_source === 'nav_proxy'
        ? `${etf.underlying_index} (price/NAV proxy, not TRI)`
        : `${etf.underlying_index} (TRI)`;
      const seriesByLabel: Record<string, SeriesPoint[]> = {
        [`${etf.name} (price)`]: rebaseTo100(priceSeries, sinceDate!),
        [benchmarkLabel]: rebaseTo100(benchmarkSeries, sinceDate!),
      };
      rivals.forEach((rival, i) => {
        const navRows = (rivalResList[i]?.data as Array<{ d: string; nav_paise: string }>) ?? [];
        seriesByLabel[`${rival.name} (NAV)`] = rebaseTo100(navRows.map((r) => ({ d: r.d, value: Number(r.nav_paise) })), sinceDate!);
      });

      setChartData(mergeSeriesForChart(seriesByLabel));
    }
    load();
    return () => { cancelled = true; };
  }, [etf.id, etf.name, etf.underlying_index, sinceDate, indices, allEtfs]);

  if (!sinceDate) return <p className="text-sm text-muted-foreground">No lots to chart.</p>;
  if (!chartData) return <div className="h-72 flex items-center justify-center text-sm text-muted-foreground">Loading chart…</div>;

  const seriesLabels = Object.keys(chartData[0] ?? {}).filter((k) => k !== 'd');
  const buyMarkerDates = new Set(holding.lots.map((l) => l.buyDate));

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
          <XAxis dataKey="d" tick={{ fontSize: 11 }} minTickGap={40} />
          <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {seriesLabels.map((label, i) => (
            <Line key={label} type="monotone" dataKey={label} stroke={LINE_COLORS[i % LINE_COLORS.length]} dot={false} strokeWidth={1.75} />
          ))}
          {chartData
            .filter((row) => buyMarkerDates.has(row.d))
            .map((row) => (
              <ReferenceDot key={row.d} x={row.d} y={row[seriesLabels[0]!] as number} r={4} fill="var(--color-accent)" stroke="none" />
            ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
