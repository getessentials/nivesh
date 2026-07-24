import { useState } from 'react';
import { toast } from 'sonner';
import { invokeFunction } from '@/lib/supabase';
import { formatPaise } from '@/lib/money';
import { api } from '@/store/api';
import { useAppDispatch } from '@/store/hooks';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface RunNowResponse {
  runId?: string;
  status?: string;
  resumed?: boolean;
  created?: boolean;
  needsConfirmation?: boolean;
  supersededRunId?: string;
  alreadyDeployedPaise?: string;
  suggestedAmountPaise?: string;
  error?: string;
}

/**
 * "Run now" (docs/01 §3.2/§3.5). A `needsConfirmation` response means the latest run this month
 * is already `done` — re-running requires the explicit "replaces plan" confirmation, pre-filled
 * with the suggested amount per the no-double-spending rule (docs/01 §3.5).
 */
export function RunNowButton() {
  const dispatch = useAppDispatch();
  const [loading, setLoading] = useState(false);
  const [confirmState, setConfirmState] = useState<RunNowResponse | null>(null);
  const [amountRupees, setAmountRupees] = useState('');

  async function runNow(confirmSupersede?: boolean, amountPaise?: string) {
    setLoading(true);
    try {
      const body: Record<string, unknown> = {};
      if (confirmSupersede) body.confirmSupersede = true;
      if (amountPaise) body.amountPaise = amountPaise;
      const res = await invokeFunction<RunNowResponse>('monthly-run', body);

      if (res.needsConfirmation) {
        setConfirmState(res);
        setAmountRupees((Number(res.suggestedAmountPaise ?? '0') / 100).toString());
        return;
      }
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.resumed ? 'Resuming your in-flight run.' : 'New monthly run started.');
      setConfirmState(null);
      dispatch(api.util.invalidateTags(['MonthlyRun', 'RecommendationItem']));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start the run.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => runNow()} disabled={loading}>
        {loading ? 'Starting…' : 'Run now'}
      </Button>

      <Dialog open={confirmState !== null} onOpenChange={(open) => !open && setConfirmState(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Replace this month's plan?</DialogTitle>
            <DialogDescription>
              You already have a completed plan this month. Re-running replaces it with a new one — lots you've
              already marked bought against the old plan are kept and feed into the new plan's portfolio view.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>Already deployed against the current plan: <span className="font-medium">{formatPaise(confirmState?.alreadyDeployedPaise ?? '0')}</span></p>
            <div className="space-y-2">
              <Label htmlFor="new-amount">New run amount (₹)</Label>
              <Input id="new-amount" type="number" min="0" value={amountRupees} onChange={(e) => setAmountRupees(e.target.value)} />
              <p className="text-xs text-muted-foreground">Suggested: remaining amount after what's already deployed. Editable.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmState(null)}>Cancel</Button>
            <Button
              disabled={loading}
              onClick={() => runNow(true, Math.round(Number(amountRupees) * 100).toString())}
            >
              Replace plan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
