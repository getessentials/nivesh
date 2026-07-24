import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolioValuation } from '@/hooks/usePortfolioValuation';
import { useGetIndicesQuery, useGetEtfsQuery, useGetThemeEtfMapQuery, useGetFeedbackScoresQuery } from '@/store/api';
import { formatPaise } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { HoldingComparisonChart } from '@/components/performance/HoldingComparisonChart';
import { PortfolioCounterfactualChart } from '@/components/performance/PortfolioCounterfactualChart';
import { FeedbackBadge } from '@/components/performance/FeedbackBadge';
import { Disclaimer } from '@/components/Disclaimer';
import type { FeedbackScoreRow } from '@/types/db';

export default function PerformancePage() {
  const { session } = useAuth();
  const userId = session!.user.id;

  const valuation = usePortfolioValuation();
  const { data: indices } = useGetIndicesQuery();
  const { data: allEtfs } = useGetEtfsQuery();
  const { data: themeEtfMap } = useGetThemeEtfMapQuery();
  const { data: feedbackScores } = useGetFeedbackScoresQuery(userId);

  const [selectedEtfId, setSelectedEtfId] = useState<number | null>(null);
  const selectedHolding = valuation.holdings.find((h) => h.etfId === selectedEtfId) ?? valuation.holdings[0];

  const latestFeedbackByEtf = useMemo(() => {
    const map = new Map<number, FeedbackScoreRow>();
    for (const s of feedbackScores ?? []) {
      if (s.scope !== 'etf') continue;
      const etfId = Number(s.ref);
      if (!map.has(etfId)) map.set(etfId, s); // rows are ordered as_of desc by the query
    }
    return map;
  }, [feedbackScores]);

  const themeAttribution = useMemo(() => {
    if (!themeEtfMap) return [];
    const byTheme = new Map<string, number>();
    for (const h of valuation.holdings) {
      const themeKeys = themeEtfMap.filter((m) => m.etf_id === h.etfId).map((m) => m.theme_key);
      if (themeKeys.length === 0) continue;
      const share = Number(h.unrealizedPaise) / themeKeys.length;
      for (const key of themeKeys) byTheme.set(key, (byTheme.get(key) ?? 0) + share);
    }
    return [...byTheme.entries()].map(([theme, unrealizedPaise]) => ({ theme, unrealizedPaise })).sort((a, b) => b.unrealizedPaise - a.unrealizedPaise);
  }, [themeEtfMap, valuation.holdings]);

  if (valuation.isLoading || !indices || !allEtfs) {
    return <Skeleton className="h-96 w-full" />;
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Performance</h1>

      {valuation.holdings.length === 0 ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">No holdings yet — charts will appear once you have at least one lot.</CardContent></Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Holding vs benchmark vs rivals</CardTitle>
              <Select value={selectedHolding?.etfId.toString()} onValueChange={(v) => setSelectedEtfId(Number(v))}>
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {valuation.holdings.map((h) => <SelectItem key={h.etfId} value={h.etfId.toString()}>{h.etf.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </CardHeader>
            <CardContent>
              {selectedHolding && (
                <>
                  <HoldingComparisonChart holding={selectedHolding} etf={selectedHolding.etf} indices={indices} allEtfs={allEtfs} />
                  <div className="mt-3">
                    <FeedbackBadge score={latestFeedbackByEtf.get(selectedHolding.etfId)} />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Portfolio vs all-in Nifty 50</CardTitle></CardHeader>
            <CardContent>
              <PortfolioCounterfactualChart holdings={valuation.holdings} />
            </CardContent>
          </Card>

          {themeAttribution.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Theme attribution (unrealized P&amp;L)</CardTitle></CardHeader>
              <CardContent>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={themeAttribution} layout="vertical" margin={{ left: 24 }}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                      <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => formatPaise(v)} />
                      <YAxis type="category" dataKey="theme" tick={{ fontSize: 11 }} width={110} />
                      <Tooltip formatter={(v) => formatPaise(Number(v))} />
                      <Bar dataKey="unrealizedPaise">
                        {themeAttribution.map((row) => (
                          <Cell key={row.theme} fill={row.unrealizedPaise >= 0 ? 'var(--color-success)' : 'var(--color-destructive)'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Approximation: an ETF mapped to more than one theme has its unrealized P&amp;L split evenly across
                  those themes — this is not a true per-theme attribution.
                </p>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle>Feedback badges</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {valuation.holdings.map((h) => (
                <div key={h.etfId} className="flex items-center justify-between text-sm">
                  <span>{h.etf.name}</span>
                  <FeedbackBadge score={latestFeedbackByEtf.get(h.etfId)} />
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      <Disclaimer />
    </div>
  );
}
