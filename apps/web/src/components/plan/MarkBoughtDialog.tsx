import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useAddTransactionMutation } from '@/store/api';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  etfId: number;
  etfName: string;
  defaultUnits: number;
  /** the plan-date close price, in rupees, used to pre-fill the estimate (docs/01 §3.2 step 6). */
  estimatedPriceRupees: number;
}

/**
 * "Mark bought" (docs/01 §3.2 step 6): pre-fills the plan-date close as an ESTIMATE the user must
 * either explicitly accept or overwrite with their actual execution price — cost basis drives
 * every downstream tax number, so silently accepting an unconfirmed estimate isn't acceptable.
 */
export function MarkBoughtDialog({ open, onOpenChange, runId, etfId, etfName, defaultUnits, estimatedPriceRupees }: Props) {
  const { session } = useAuth();
  const [addTransaction, { isLoading }] = useAddTransactionMutation();
  const [units, setUnits] = useState(defaultUnits);
  const [priceRupees, setPriceRupees] = useState(estimatedPriceRupees);
  const [useEstimate, setUseEstimate] = useState(false);
  const [tradedOn, setTradedOn] = useState(() => new Date().toISOString().slice(0, 10));

  const priceTouched = priceRupees !== estimatedPriceRupees;
  const canSubmit = units > 0 && priceRupees > 0 && (priceTouched || useEstimate);

  async function handleSubmit() {
    if (!session || !canSubmit) return;
    try {
      await addTransaction({
        user_id: session.user.id,
        etf_id: etfId,
        side: 'buy',
        qty: units,
        price_paise: Math.round(priceRupees * 100).toString(),
        traded_on: tradedOn,
        source: 'plan',
        run_id: runId,
      }).unwrap();
      toast.success(`Marked ${units} unit(s) of ${etfName} as bought.`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to record the purchase.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark bought — {etfName}</DialogTitle>
          <DialogDescription>Confirm what you actually bought. This creates a lot used for cost basis and tax calculations.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="units">Units</Label>
            <Input id="units" type="number" min="1" step="1" value={units} onChange={(e) => setUnits(Number(e.target.value))} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="price">Execution price (₹/unit)</Label>
            <Input id="price" type="number" min="0" step="0.01" value={priceRupees} onChange={(e) => setPriceRupees(Number(e.target.value))} />
            {!priceTouched && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={useEstimate} onChange={(e) => setUseEstimate(e.target.checked)} className="size-3.5" />
                This is an estimated plan-date close — I confirm I paid this price
              </label>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="tradedOn">Trade date</Label>
            <Input id="tradedOn" type="date" value={tradedOn} onChange={(e) => setTradedOn(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSubmit || isLoading} onClick={handleSubmit}>
            {isLoading ? 'Saving…' : 'Confirm bought'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
