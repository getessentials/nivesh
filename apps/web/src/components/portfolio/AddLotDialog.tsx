import { useState } from 'react';
import { toast } from 'sonner';
import { computeRemainingLots, type AssetClass } from '@niveshetf/engine';
import { useAuth } from '@/hooks/useAuth';
import {
  useAddTransactionMutation, useGetEtfsQuery, useGetTransactionsQuery, useGetChargesConfigQuery,
  useGetUserChargesOverridesQuery, useGetProfileQuery,
} from '@/store/api';
import { toEngineChargeConfig, toEngineOverrides, toEngineTransactions } from '@/lib/holdingsCompute';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function AddLotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { session } = useAuth();
  const userId = session!.user.id;
  const { data: etfs } = useGetEtfsQuery();
  const { data: profile } = useGetProfileQuery(userId);
  const { data: transactions } = useGetTransactionsQuery(userId);
  const { data: chargesConfig } = useGetChargesConfigQuery(profile?.broker_profile ?? 'discount_default', { skip: !profile });
  const { data: overrides } = useGetUserChargesOverridesQuery(userId);
  const [addTransaction, { isLoading }] = useAddTransactionMutation();

  const [etfId, setEtfId] = useState<string>('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('');
  const [priceRupees, setPriceRupees] = useState('');
  const [tradedOn, setTradedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setError(null);
    if (!etfId || !qty || !priceRupees || !transactions || !etfs || !chargesConfig) return;
    const etf = etfs.find((e) => e.id === Number(etfId));
    if (!etf) return;
    const pricePaise = BigInt(Math.round(Number(priceRupees) * 100));

    // Oversell guard (docs/09 §6) — simulate before writing.
    if (side === 'sell') {
      const existingForEtf = transactions.filter((t) => t.etf_id === etf.id);
      const combined = [
        ...toEngineTransactions(existingForEtf),
        { id: 'new-lot', side, qty: Number(qty), pricePaise, tradedOn, createdAt: new Date().toISOString() },
      ];
      try {
        computeRemainingLots(combined, etf.asset_class as AssetClass, toEngineChargeConfig(chargesConfig), toEngineOverrides(overrides ?? []));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'This sell would exceed your available quantity.');
        return;
      }
    }

    try {
      await addTransaction({
        user_id: userId, etf_id: etf.id, side, qty: Number(qty), price_paise: pricePaise.toString(), traded_on: tradedOn, source: 'manual',
      }).unwrap();
      toast.success('Lot added.');
      onOpenChange(false);
      setEtfId(''); setQty(''); setPriceRupees('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add lot.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a lot</DialogTitle>
          <DialogDescription>Manually record a buy or sell transaction.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>ETF</Label>
            <Select value={etfId} onValueChange={setEtfId}>
              <SelectTrigger><SelectValue placeholder="Select an ETF" /></SelectTrigger>
              <SelectContent>
                {(etfs ?? []).map((e) => <SelectItem key={e.id} value={e.id.toString()}>{e.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Side</Label>
            <Select value={side} onValueChange={(v) => setSide(v as 'buy' | 'sell')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="buy">Buy</SelectItem>
                <SelectItem value="sell">Sell</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="qty">Units</Label>
              <Input id="qty" type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="price">Price (₹/unit)</Label>
              <Input id="price" type="number" min="0" step="0.01" value={priceRupees} onChange={(e) => setPriceRupees(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="tradedOn">Trade date</Label>
            <Input id="tradedOn" type="date" value={tradedOn} onChange={(e) => setTradedOn(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={isLoading || !etfId || !qty || !priceRupees} onClick={handleSubmit}>
            {isLoading ? 'Saving…' : 'Add lot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
