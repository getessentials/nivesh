import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useAddTransactionsMutation, useGetTransactionsQuery, useGetEtfsQuery, useGetChargesConfigQuery, useGetUserChargesOverridesQuery, useGetProfileQuery } from '@/store/api';
import { toEngineChargeConfig, toEngineOverrides } from '@/lib/holdingsCompute';
import { parseAndValidateCsv, revalidateForImport, type ParsedCsvRow } from '@/lib/csvImport';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatPaiseExact } from '@/lib/money';

export function CsvImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const { data: profile } = useGetProfileQuery(userId);
  const { data: transactions } = useGetTransactionsQuery(userId);
  const { data: etfs } = useGetEtfsQuery();
  const { data: chargesConfig } = useGetChargesConfigQuery(profile?.broker_profile ?? 'discount_default', { skip: !profile });
  const { data: overrides } = useGetUserChargesOverridesQuery(userId);
  const [addTransactions, { isLoading: importing }] = useAddTransactionsMutation();

  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<ParsedCsvRow[] | null>(null);
  const [excludedRowNumbers, setExcludedRowNumbers] = useState<Set<number>>(new Set());

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !transactions || !etfs || !chargesConfig) return;
    setFileError(null);
    setRows(null);
    const result = await parseAndValidateCsv(
      file, transactions, etfs, toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? [])
    );
    if (!result.ok) {
      setFileError(result.error ? `${result.error.rowNumber ? `Row ${result.error.rowNumber}: ` : ''}${result.error.message}` : 'Import failed.');
      return;
    }
    setRows(result.rows);
    setExcludedRowNumbers(new Set(result.rows.filter((r) => r.isDuplicate).map((r) => r.rowNumber)));
  }

  async function handleConfirm() {
    if (!rows || !transactions || !etfs || !chargesConfig) return;
    const toImport = rows.filter((r) => !excludedRowNumbers.has(r.rowNumber));

    // Excluding rows (e.g. unchecking an auto-flagged duplicate) can turn the already-validated
    // full set into an invalid one — re-simulate against exactly what's about to be inserted.
    const revalidationError = revalidateForImport(toImport, transactions, etfs, toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? []));
    if (revalidationError) {
      toast.error(`${revalidationError.rowNumber ? `Row ${revalidationError.rowNumber}: ` : ''}${revalidationError.message}`);
      return;
    }

    try {
      await addTransactions(
        toImport.map((r) => ({
          user_id: userId, etf_id: r.etfId, side: r.side, qty: r.qty,
          price_paise: r.pricePaise.toString(), traded_on: r.tradedOn, source: 'csv' as const,
        }))
      ).unwrap();
      toast.success(`Imported ${toImport.length} transaction(s).`);
      setRows(null);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Import failed.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import transactions from CSV</DialogTitle>
          <DialogDescription>
            Columns: isin or yahoo_symbol, side (buy/sell), qty, price_paise or price_rupees, traded_on (YYYY-MM-DD).
            Max 1MB, 5,000 rows, UTF-8.
          </DialogDescription>
        </DialogHeader>

        {!rows && (
          <div className="space-y-3">
            <input type="file" accept=".csv,text/csv" onChange={handleFileChange} className="text-sm" />
            {fileError && <p className="text-sm text-destructive">{fileError}</p>}
          </div>
        )}

        {rows && (
          <div className="space-y-3">
            <div className="max-h-96 overflow-y-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Row</TableHead>
                    <TableHead>ETF</TableHead>
                    <TableHead>Side</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Include</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.rowNumber}>
                      <TableCell>{r.rowNumber}</TableCell>
                      <TableCell>{etfs?.find((e) => e.id === r.etfId)?.name ?? r.etfId}</TableCell>
                      <TableCell>{r.side}</TableCell>
                      <TableCell>{r.qty}</TableCell>
                      <TableCell>{formatPaiseExact(r.pricePaise)}</TableCell>
                      <TableCell>{r.tradedOn}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={!excludedRowNumbers.has(r.rowNumber)}
                            onChange={(e) => setExcludedRowNumbers((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.delete(r.rowNumber); else next.add(r.rowNumber);
                              return next;
                            })}
                          />
                          {r.isDuplicate && <Badge variant="outline">probable duplicate</Badge>}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRows(null)}>Back</Button>
              <Button disabled={importing} onClick={handleConfirm}>
                {importing ? 'Importing…' : `Import ${rows.length - excludedRowNumbers.size} row(s)`}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
