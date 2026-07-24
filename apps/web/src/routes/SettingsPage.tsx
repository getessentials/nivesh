import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useGetProfileQuery, useUpsertProfileMutation, useGetMonthlyRunsQuery, useGetMetricsReviewQueueQuery, useGetIngestQuarantineQuery } from '@/store/api';
import { invokeFunction } from '@/lib/supabase';
import { formatPaise } from '@/lib/money';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChargeOverridesCard } from '@/components/settings/ChargeOverridesCard';
import type { RiskAppetite } from '@niveshetf/engine';

/**
 * Owner-admin visibility is a client-side UX hint ONLY (docs/09 §2.1's ADMIN_USER_IDS allowlist
 * is enforced server-side, in the Edge Functions themselves — this env var never grants access,
 * it just avoids showing admin controls to an obviously non-admin session).
 */
const ADMIN_USER_IDS = (import.meta.env.VITE_ADMIN_USER_IDS as string | undefined)?.split(',').filter(Boolean) ?? [];

export default function SettingsPage() {
  const { session } = useAuth();
  const userId = session!.user.id;
  const isAdmin = ADMIN_USER_IDS.includes(userId);

  const { data: profile, isLoading: profileLoading } = useGetProfileQuery(userId);
  const [upsertProfile, { isLoading: saving }] = useUpsertProfileMutation();
  const { data: runs } = useGetMonthlyRunsQuery(userId);
  const { data: reviewQueue } = useGetMetricsReviewQueueQuery(undefined, { skip: !isAdmin });
  const { data: quarantine } = useGetIngestQuarantineQuery(undefined, { skip: !isAdmin });

  const [defaultAmountRupees, setDefaultAmountRupees] = useState('');
  const [risk, setRisk] = useState<RiskAppetite | ''>('');
  const [forcingResearch, setForcingResearch] = useState(false);

  const effectiveAmount = defaultAmountRupees !== '' ? defaultAmountRupees : profile ? (Number(profile.default_amount_paise) / 100).toString() : '';
  const effectiveRisk = risk || profile?.risk || '';

  async function handleSaveProfile() {
    if (!profile) return;
    try {
      await upsertProfile({
        user_id: userId,
        default_amount_paise: Math.round(Number(effectiveAmount) * 100).toString(),
        risk: (effectiveRisk || profile.risk) as RiskAppetite,
      }).unwrap();
      toast.success('Profile updated.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update profile.');
    }
  }

  async function handleForceResearch() {
    setForcingResearch(true);
    try {
      await invokeFunction('admin-force-research', {});
      toast.success('Force re-research requested.');
    } catch {
      toast.error('admin-force-research is not deployed yet.');
    } finally {
      setForcingResearch(false);
    }
  }

  if (profileLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader><CardTitle>Profile</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Monthly default amount (₹)</Label>
              <Input type="number" min="0" value={effectiveAmount} onChange={(e) => setDefaultAmountRupees(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Risk appetite</Label>
              <Select value={effectiveRisk} onValueChange={(v) => setRisk(v as RiskAppetite)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">Conservative</SelectItem>
                  <SelectItem value="moderate">Moderate</SelectItem>
                  <SelectItem value="aggressive">Aggressive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={handleSaveProfile} disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</Button>
        </CardContent>
      </Card>

      <ChargeOverridesCard />

      <Card>
        <CardHeader><CardTitle>Run history</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead>Seq</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Residual</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(runs ?? []).map((r) => (
                <TableRow key={r.id}>
                  <TableCell>{r.run_month.slice(0, 7)}</TableCell>
                  <TableCell>{r.seq}</TableCell>
                  <TableCell><Badge variant={r.status === 'done' ? 'default' : r.status === 'failed' ? 'destructive' : 'secondary'}>{r.status}</Badge></TableCell>
                  <TableCell className="tabular-nums">{formatPaise(r.amount_paise)}</TableCell>
                  <TableCell className="tabular-nums">{r.residual_paise ? formatPaise(r.residual_paise) : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {isAdmin && (
        <Card>
          <CardHeader>
            <CardTitle>Owner-admin</CardTitle>
            <CardDescription>Manual data submission paths (docs/09 §2.1) — authorization is enforced server-side regardless of this section's visibility.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-1">Force re-research this month</p>
              <p className="text-xs text-muted-foreground mb-2">Counts against the LLM spend cap (docs/10 §7).</p>
              <Button variant="outline" onClick={handleForceResearch} disabled={forcingResearch}>
                {forcingResearch ? 'Requesting…' : 'Force re-research'}
              </Button>
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Metrics review queue ({reviewQueue?.length ?? 0} pending)</p>
              <p className="text-xs text-muted-foreground">Submission form ships with the admin-submit-metrics Edge Function (not yet deployed).</p>
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Ingest quarantine ({quarantine?.length ?? 0} pending)</p>
              <p className="text-xs text-muted-foreground">Resolution actions ship with the admin-resolve-quarantine Edge Function (not yet deployed).</p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
