import { toast } from 'sonner';
import { computeRemainingLots, type AssetClass } from '@niveshetf/engine';
import { useAuth } from '@/hooks/useAuth';
import {
  useDeleteTransactionMutation, useGetTransactionsQuery, useGetChargesConfigQuery,
  useGetUserChargesOverridesQuery, useGetProfileQuery,
} from '@/store/api';
import { toEngineChargeConfig, toEngineOverrides, toEngineTransactions } from '@/lib/holdingsCompute';
import { formatPaiseExact } from '@/lib/money';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import type { HoldingValuation } from '@/lib/holdingsCompute';
import type { EtfRow } from '@/types/db';

export function LotDrawer({
  holding, etf, open, onOpenChange,
}: {
  holding: (HoldingValuation & { etf: EtfRow }) | null;
  etf: EtfRow | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const [deleteTransaction] = useDeleteTransactionMutation();
  const { data: profile } = useGetProfileQuery(userId);
  const { data: transactions } = useGetTransactionsQuery(userId);
  const { data: chargesConfig } = useGetChargesConfigQuery(profile?.broker_profile ?? 'discount_default', { skip: !profile });
  const { data: overrides } = useGetUserChargesOverridesQuery(userId);

  async function handleDelete(lotId: string) {
    // Oversell guard (docs/09 §6) — simulate the delete before writing, matching AddLotDialog and
    // CSV import's own pre-flight checks: deleting an early buy can uncover a later sell. Fails
    // CLOSED (blocks the delete) if the data needed to simulate it isn't loaded yet — never fall
    // through to an unchecked delete just because a query hasn't resolved.
    if (!etf || !transactions || !chargesConfig) {
      toast.error('Still loading — try again in a moment.');
      return;
    }
    const remainingForEtf = transactions.filter((t) => t.etf_id === etf.id && t.id !== lotId);
    try {
      computeRemainingLots(
        toEngineTransactions(remainingForEtf), etf.asset_class as AssetClass,
        toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? [])
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Deleting this lot would uncover a later sell — not allowed.');
      return;
    }
    try {
      await deleteTransaction(lotId).unwrap();
      toast.success('Lot deleted.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete lot — this may uncover a later sell.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{etf?.name ?? 'Holding'} — lots</DialogTitle>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Buy date</TableHead>
              <TableHead>Qty</TableHead>
              <TableHead>Buy price</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {holding?.lots.map((lot) => (
              <TableRow key={lot.id}>
                <TableCell>{lot.buyDate}</TableCell>
                <TableCell>{lot.qty}</TableCell>
                <TableCell>{formatPaiseExact(lot.buyPricePaise)}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(lot.id)}>
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}
