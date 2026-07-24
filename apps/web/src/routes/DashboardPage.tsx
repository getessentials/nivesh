import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { firstTradingDayOfMonth } from '@niveshetf/shared';
import { useAuth } from '@/hooks/useAuth';
import { usePortfolioValuation } from '@/hooks/usePortfolioValuation';
import { useGetLatestMonthlyRunQuery, useGetNseHolidaysQuery, useGetRecentJobRunsQuery, useGetIngestQuarantineQuery } from '@/store/api';
import { formatPaise } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Disclaimer } from '@/components/Disclaimer';
import { failReasonLabel } from '@/lib/failReasons';
import { AlertTriangle, ArrowRight } from 'lucide-react';

function nextRunDateLabel(holidays: Set<string> | undefined): string {
  if (!holidays) return '—';
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const yyyyMM = nextMonth.toISOString().slice(0, 7);
  try {
    return firstTradingDayOfMonth(yyyyMM, holidays);
  } catch {
    return '—';
  }
}

export default function DashboardPage() {
  const { session } = useAuth();
  const userId = session!.user.id;

  const { data: latestRun, isLoading: runLoading } = useGetLatestMonthlyRunQuery(userId);
  const { data: holidayRows } = useGetNseHolidaysQuery();
  const { data: jobRuns } = useGetRecentJobRunsQuery(20);
  const { data: quarantine } = useGetIngestQuarantineQuery();
  const valuation = usePortfolioValuation();

  const holidaySet = useMemo(() => (holidayRows ? new Set(holidayRows.map((r) => r.d)) : undefined), [holidayRows]);
  const nextRun = nextRunDateLabel(holidaySet);

  const recentFailedJobs = (jobRuns ?? []).filter((j) => j.ok === false);
  const unresolvedQuarantineCount = quarantine?.length ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Next scheduled run: {nextRun}</p>
      </div>

      {(recentFailedJobs.length > 0 || unresolvedQuarantineCount > 0) && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Data pipeline needs attention</AlertTitle>
          <AlertDescription>
            {recentFailedJobs.length > 0 && <div>{recentFailedJobs.length} recent ingestion job(s) failed.</div>}
            {unresolvedQuarantineCount > 0 && <div>{unresolvedQuarantineCount} row(s) quarantined pending review.</div>}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Invested</CardTitle>
          </CardHeader>
          <CardContent>
            {valuation.isLoading ? <Skeleton className="h-8 w-32" /> : (
              <p className="text-2xl font-semibold tabular-nums">{formatPaise(valuation.totalInvestedPaise)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Current value</CardTitle>
          </CardHeader>
          <CardContent>
            {valuation.isLoading ? <Skeleton className="h-8 w-32" /> : (
              <p className="text-2xl font-semibold tabular-nums">{formatPaise(valuation.totalCurrentValuePaise)}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unrealized P&amp;L</CardTitle>
          </CardHeader>
          <CardContent>
            {valuation.isLoading ? <Skeleton className="h-8 w-32" /> : (
              <p className={`text-2xl font-semibold tabular-nums ${valuation.totalUnrealizedPaise >= 0n ? 'text-success' : 'text-destructive'}`}>
                {valuation.totalUnrealizedPaise >= 0n ? '+' : ''}{formatPaise(valuation.totalUnrealizedPaise)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Latest monthly plan</CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link to="/plan">
              View plan <ArrowRight className="size-4 ml-1" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {runLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : !latestRun ? (
            <p className="text-sm text-muted-foreground">
              Data warming up — your first plan will be available once a full month of price/NAV/TRI data has been ingested.
            </p>
          ) : latestRun.status === 'failed' ? (
            <div className="space-y-1">
              <Badge variant="destructive">Run failed</Badge>
              <p className="text-sm text-muted-foreground">
                {failReasonLabel(latestRun.fail_reason)}
              </p>
            </div>
          ) : latestRun.status === 'done' ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm">Run for {latestRun.run_month.slice(0, 7)} is ready.</p>
                <p className="text-xs text-muted-foreground">Amount: {formatPaise(latestRun.amount_paise)} + carry {formatPaise(latestRun.carry_in_paise)}</p>
              </div>
              <Badge className="bg-success text-success-foreground">Done</Badge>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{latestRun.status}</Badge>
              <p className="text-sm text-muted-foreground">Your plan is being built — check back shortly.</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Disclaimer />
    </div>
  );
}
