import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import {
  useGetMonthlyRunsQuery, useGetRecommendationItemsQuery, useGetRunGateResultsQuery,
  useGetThemesQuery, useGetEtfsQuery,
} from '@/store/api';
import { formatPaise } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ThemeCard } from '@/components/plan/ThemeCard';
import { ExcludedEtfList } from '@/components/plan/ExcludedEtfList';
import { RunNowButton } from '@/components/plan/RunNowButton';
import { Disclaimer } from '@/components/Disclaimer';
import { failReasonLabel } from '@/lib/failReasons';

export default function PlanPage() {
  const { runId: runIdParam } = useParams();
  const { session } = useAuth();
  const userId = session!.user.id;

  const { data: runs, isLoading: runsLoading } = useGetMonthlyRunsQuery(userId);
  const run = useMemo(() => {
    if (!runs) return undefined;
    if (runIdParam) return runs.find((r) => r.id === runIdParam);
    // Default: the latest non-superseded run, falling back to the latest run of any status.
    return runs.find((r) => r.status !== 'superseded') ?? runs[0];
  }, [runs, runIdParam]);

  const { data: items, isLoading: itemsLoading } = useGetRecommendationItemsQuery(run?.id ?? '', { skip: !run });
  const { data: gateResults } = useGetRunGateResultsQuery(run?.id ?? '', { skip: !run });
  const { data: themes } = useGetThemesQuery();
  const { data: etfs } = useGetEtfsQuery();

  const themeById = useMemo(() => new Map((themes ?? []).map((t) => [t.key, t])), [themes]);
  const etfById = useMemo(() => new Map((etfs ?? []).map((e) => [e.id, e])), [etfs]);

  const themeItems = useMemo(() => (items ?? []).filter((i) => i.level === 'theme').sort((a, b) => a.rank - b.rank), [items]);
  const etfItemsByTheme = useMemo(() => {
    const map = new Map<string, typeof themeItems>();
    for (const i of items ?? []) {
      if (i.level !== 'etf' || !i.theme_key) continue;
      const arr = map.get(i.theme_key) ?? [];
      arr.push(i);
      map.set(i.theme_key, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.rank - b.rank);
    return map;
  }, [items]);

  if (runsLoading) {
    return <div className="space-y-4"><Skeleton className="h-10 w-64" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Monthly Plan</h1>
          {run && <p className="text-sm text-muted-foreground">{run.run_month.slice(0, 7)} · seq {run.seq}</p>}
        </div>
        <RunNowButton />
      </div>

      {!run && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No run yet this month. Data warming up, or click "Run now" once your profile is set up and market data has landed.
          </CardContent>
        </Card>
      )}

      {run?.status === 'failed' && (
        <Card>
          <CardHeader><CardTitle className="text-base">Run failed</CardTitle></CardHeader>
          <CardContent>
            <Badge variant="destructive" className="mb-2">failed</Badge>
            <p className="text-sm text-muted-foreground">
              {failReasonLabel(run.fail_reason)}
            </p>
          </CardContent>
        </Card>
      )}

      {run && run.status !== 'failed' && run.status !== 'done' && (
        <Card>
          <CardContent className="pt-6 flex items-center gap-3">
            <Badge variant="secondary">{run.status}</Badge>
            <p className="text-sm text-muted-foreground">Your plan is being built — this page will update automatically once it's ready.</p>
          </CardContent>
        </Card>
      )}

      {run?.status === 'done' && (
        <>
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Amount (X)</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatPaise(run.amount_paise)}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Carry-in</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatPaise(run.carry_in_paise)}</p></CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Residual (carry forward)</CardTitle></CardHeader>
              <CardContent><p className="text-xl font-semibold tabular-nums">{formatPaise(run.residual_paise ?? '0')}</p></CardContent>
            </Card>
          </div>

          {itemsLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <div className="space-y-4">
              {themeItems.map((themeItem, i) => (
                <ThemeCard
                  key={themeItem.id}
                  themeItem={themeItem}
                  theme={themeById.get(themeItem.theme_key!)}
                  etfItems={etfItemsByTheme.get(themeItem.theme_key!) ?? []}
                  etfById={etfById}
                  runId={run.id}
                  nextThemeItem={themeItems[i + 1]}
                />
              ))}
            </div>
          )}

          {gateResults && <ExcludedEtfList gateResults={gateResults} etfById={etfById} />}
        </>
      )}

      <Disclaimer />
    </div>
  );
}
