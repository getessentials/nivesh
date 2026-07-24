import { useState } from 'react';
import { toast } from 'sonner';
import { useGetMetricsReviewQueueQuery, useGetEtfsQuery, api } from '@/store/api';
import { useAppDispatch } from '@/store/hooks';
import { invokeFunction } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { HelpStepsDialog } from '@/components/HelpStepsDialog';
import { METRICS_FORM_STEPS } from '@/lib/manualStepsHelp';

/** One row of the bulk-paste JSON format — etf_name (not etf_id, since that's what's legible to
 *  paste from a factsheet/spreadsheet) matched case-insensitively against the queue's ETF names.
 *  Numeric fields accept `null` for "not available" (e.g. a fund too young to have 3y/5y TD). */
interface JsonPasteRow {
  etf_name: string;
  as_of: string;
  aum_cr: number | null;
  ter_pct: number | null;
  te_1y_pct: number | null;
  td_1y_pct: number | null;
  td_3y_pct: number | null;
  td_5y_pct: number | null;
}

/** One (etf_id, as_of) row's in-progress manual entry — undefined fields just aren't typed yet. */
interface DraftRow {
  aum_cr?: string;
  ter_pct?: string;
  tracking_error_1y?: string;
  tracking_diff_1y?: string;
  tracking_diff_3y?: string;
  tracking_diff_5y?: string;
}

const FIELDS: Array<{ key: keyof DraftRow; label: string; step: string }> = [
  { key: 'aum_cr', label: 'AUM (₹cr)', step: '0.01' },
  { key: 'ter_pct', label: 'TER (%)', step: '0.001' },
  { key: 'tracking_error_1y', label: 'TE 1y (%)', step: '0.01' },
  { key: 'tracking_diff_1y', label: 'TD 1y (%)', step: '0.01' },
  { key: 'tracking_diff_3y', label: 'TD 3y (%)', step: '0.01' },
  { key: 'tracking_diff_5y', label: 'TD 5y (%)', step: '0.01' },
];

function rowKey(etfId: number, asOf: string): string {
  return `${etfId}|${asOf}`;
}

/** Owner-admin form for the etf_metrics fields no free API provides (docs/02 §4) — clears
 *  metrics_review_queue entries via admin-submit-metrics. Server re-validates everything typed
 *  here; this component's own number-input constraints are a UX nicety, not the real gate. */
export function MetricsReviewQueueCard() {
  const { data: queue, isLoading: queueLoading } = useGetMetricsReviewQueueQuery();
  const { data: etfs } = useGetEtfsQuery();
  const dispatch = useAppDispatch();

  const [drafts, setDrafts] = useState<Record<string, DraftRow>>({});
  const [submitting, setSubmitting] = useState(false);
  const [jsonPaste, setJsonPaste] = useState('');
  const [jsonPasteOpen, setJsonPasteOpen] = useState(false);

  const etfNameById = new Map((etfs ?? []).map((e) => [e.id, e.name]));
  const etfIdByLowerName = new Map((etfs ?? []).map((e) => [e.name.toLowerCase().trim(), e.id]));
  const queueKeySet = new Set((queue ?? []).map((r) => rowKey(r.etf_id, r.as_of)));

  function numToStr(n: number | null | undefined): string | undefined {
    return n === null || n === undefined ? undefined : String(n);
  }

  function handleLoadJson() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPaste);
    } catch (err) {
      toast.error(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      toast.error('JSON must be an array of rows.');
      return;
    }

    const rows = parsed as JsonPasteRow[];
    const nextDrafts: Record<string, DraftRow> = {};
    const unmatchedNames: string[] = [];
    const unmatchedQueue: string[] = [];

    for (const row of rows) {
      const etfId = etfIdByLowerName.get((row.etf_name ?? '').toLowerCase().trim());
      if (etfId === undefined) {
        unmatchedNames.push(row.etf_name);
        continue;
      }
      const key = rowKey(etfId, row.as_of);
      if (!queueKeySet.has(key)) {
        unmatchedQueue.push(`${row.etf_name} (${row.as_of})`);
        continue;
      }
      nextDrafts[key] = {
        aum_cr: numToStr(row.aum_cr),
        ter_pct: numToStr(row.ter_pct),
        tracking_error_1y: numToStr(row.te_1y_pct),
        tracking_diff_1y: numToStr(row.td_1y_pct),
        tracking_diff_3y: numToStr(row.td_3y_pct),
        tracking_diff_5y: numToStr(row.td_5y_pct),
      };
    }

    setDrafts((prev) => ({ ...prev, ...nextDrafts }));
    const loadedCount = Object.keys(nextDrafts).length;
    if (loadedCount > 0) toast.success(`Loaded ${loadedCount} row(s) into the table below — review, then submit.`);
    if (unmatchedNames.length > 0) toast.error(`No ETF matched: ${unmatchedNames.join(', ')}`);
    if (unmatchedQueue.length > 0) toast.error(`Not in the pending queue (already resolved, or wrong as_of): ${unmatchedQueue.join(', ')}`);
    if (loadedCount > 0) {
      setJsonPaste('');
      setJsonPasteOpen(false);
    }
  }

  function setField(etfId: number, asOf: string, field: keyof DraftRow, value: string) {
    const key = rowKey(etfId, asOf);
    setDrafts((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  }

  function rowIsFilled(draft: DraftRow | undefined): boolean {
    if (!draft) return false;
    // 3y/5y are optional (young funds may not have them yet) — the other four are required.
    return draft.aum_cr !== undefined && draft.aum_cr !== '' &&
      draft.ter_pct !== undefined && draft.ter_pct !== '' &&
      draft.tracking_error_1y !== undefined && draft.tracking_error_1y !== '' &&
      draft.tracking_diff_1y !== undefined && draft.tracking_diff_1y !== '';
  }

  const filledCount = (queue ?? []).filter((r) => rowIsFilled(drafts[rowKey(r.etf_id, r.as_of)])).length;

  async function handleSubmitAll() {
    const rows = queue ?? [];
    const submissions = rows
      .filter((r) => rowIsFilled(drafts[rowKey(r.etf_id, r.as_of)]))
      .map((r) => {
        const d = drafts[rowKey(r.etf_id, r.as_of)]!;
        return {
          etf_id: r.etf_id,
          as_of: r.as_of,
          aum_cr: Number(d.aum_cr),
          ter_pct: Number(d.ter_pct),
          tracking_error_1y: Number(d.tracking_error_1y),
          tracking_diff_1y: Number(d.tracking_diff_1y),
          tracking_diff_3y: d.tracking_diff_3y ? Number(d.tracking_diff_3y) : null,
          tracking_diff_5y: d.tracking_diff_5y ? Number(d.tracking_diff_5y) : null,
        };
      });
    if (submissions.length === 0) return;

    setSubmitting(true);
    try {
      const result = await invokeFunction<{ ok?: boolean; error?: string; resolved?: number }>(
        'admin-submit-metrics',
        { submissions }
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`Submitted ${result.resolved ?? submissions.length} ETF metrics rows.`);
        setDrafts({});
        dispatch(api.util.invalidateTags(['MetricsReviewQueue']));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'admin-submit-metrics request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  if (queueLoading) return null;
  if (!queue || queue.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Metrics review queue</CardTitle>
          <CardDescription>Nothing pending — every active ETF has AUM/TER/tracking data on file.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Metrics review queue ({queue.length} pending)
          <HelpStepsDialog title="How to fill in AUM/TER/tracking-error" steps={METRICS_FORM_STEPS} />
        </CardTitle>
        <CardDescription>
          No free API publishes AUM/TER/tracking-error — pull these from each fund house's factsheet
          and enter them below. Rows left blank are skipped; fill AUM/TER/TE1y/TD1y at minimum (TD3y/TD5y optional).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Button variant="outline" size="sm" onClick={() => setJsonPasteOpen((v) => !v)}>
            {jsonPasteOpen ? 'Hide JSON paste' : 'Paste JSON instead'}
          </Button>
          {jsonPasteOpen && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-muted-foreground">
                Array of {'{'}etf_name, as_of, aum_cr, ter_pct, te_1y_pct, td_1y_pct, td_3y_pct, td_5y_pct{'}'}
                {' '}— etf_name is matched case-insensitively against the ETF names below; td_3y_pct/td_5y_pct may be null.
                Loading only fills the table for review — nothing is submitted until you click Submit.
              </p>
              <Textarea
                className="font-mono text-xs h-40"
                placeholder='[{"etf_name": "Nippon India ETF Nifty 50 BeES", "as_of": "2026-07-24", "aum_cr": 64785.34, ...}]'
                value={jsonPaste}
                onChange={(e) => setJsonPaste(e.target.value)}
              />
              <Button size="sm" onClick={handleLoadJson} disabled={!jsonPaste.trim()}>Load into table</Button>
            </div>
          )}
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">ETF</TableHead>
                <TableHead className="whitespace-nowrap">As of</TableHead>
                {FIELDS.map((f) => <TableHead key={f.key} className="whitespace-nowrap">{f.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {queue.map((r) => {
                const key = rowKey(r.etf_id, r.as_of);
                const draft = drafts[key] ?? {};
                return (
                  <TableRow key={key}>
                    <TableCell className="whitespace-nowrap">{etfNameById.get(r.etf_id) ?? `etf_id ${r.etf_id}`}</TableCell>
                    <TableCell className="whitespace-nowrap">{r.as_of}</TableCell>
                    {FIELDS.map((f) => (
                      <TableCell key={f.key}>
                        <Input
                          className="w-24"
                          type="number"
                          step={f.step}
                          value={draft[f.key] ?? ''}
                          onChange={(e) => setField(r.etf_id, r.as_of, f.key, e.target.value)}
                        />
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <Button onClick={handleSubmitAll} disabled={submitting || filledCount === 0}>
          {submitting ? 'Submitting…' : `Submit ${filledCount} filled row${filledCount === 1 ? '' : 's'}`}
        </Button>
      </CardContent>
    </Card>
  );
}
