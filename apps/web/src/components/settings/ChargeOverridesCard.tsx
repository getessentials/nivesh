import { useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useGetUserChargesOverridesQuery, useUpsertUserChargesOverrideMutation, useDeleteUserChargesOverrideMutation } from '@/store/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Trash2 } from 'lucide-react';
import type { AssetClass } from '@/types/db';

const CHARGE_KEYS = ['brokerage', 'txn', 'sebi', 'stamp_buy', 'gst', 'dp_sell_flat', 'stt_sell'];

export function ChargeOverridesCard() {
  const { session } = useAuth();
  const userId = session!.user.id;
  const { data: overrides } = useGetUserChargesOverridesQuery(userId);
  const [upsert] = useUpsertUserChargesOverrideMutation();
  const [remove] = useDeleteUserChargesOverrideMutation();

  const [chargeKey, setChargeKey] = useState(CHARGE_KEYS[0]!);
  const [assetClass, setAssetClass] = useState<AssetClass>('equity');
  const [side, setSide] = useState<'buy' | 'sell' | 'both'>('both');
  const [kind, setKind] = useState<'pct' | 'flat_paise'>('pct');
  const [value, setValue] = useState('');

  async function handleAdd() {
    try {
      await upsert({
        user_id: userId, charge_key: chargeKey, asset_class: assetClass, side, kind,
        value: value, tax_deductible: chargeKey !== 'stt_sell',
      }).unwrap();
      toast.success('Override saved.');
      setValue('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save override.');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Charge overrides</CardTitle>
        <CardDescription>Per-charge overrides of your broker profile's defaults. Global config is never client-writable — these only affect your own calculations.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Charge</TableHead>
              <TableHead>Asset class</TableHead>
              <TableHead>Side</TableHead>
              <TableHead>Value</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(overrides ?? []).map((o) => (
              <TableRow key={`${o.charge_key}-${o.asset_class}`}>
                <TableCell>{o.charge_key}</TableCell>
                <TableCell>{o.asset_class}</TableCell>
                <TableCell>{o.side}</TableCell>
                <TableCell>{o.kind === 'pct' ? `${o.value}%` : `₹${(Number(o.value) / 100).toFixed(2)}`}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => remove({ userId, chargeKey: o.charge_key, assetClass: o.asset_class })}>
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="flex items-end gap-2 flex-wrap">
          <Select value={chargeKey} onValueChange={setChargeKey}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>{CHARGE_KEYS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={assetClass} onValueChange={(v) => setAssetClass(v as AssetClass)}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              {(['equity', 'gold', 'silver', 'debt', 'intl'] as AssetClass[]).map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={side} onValueChange={(v) => setSide(v as 'buy' | 'sell' | 'both')}>
            <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="buy">buy</SelectItem>
              <SelectItem value="sell">sell</SelectItem>
              <SelectItem value="both">both</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={(v) => setKind(v as 'pct' | 'flat_paise')}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pct">% of order</SelectItem>
              <SelectItem value="flat_paise">flat (paise)</SelectItem>
            </SelectContent>
          </Select>
          <Input className="w-28" type="number" step="0.0001" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} />
          <Button onClick={handleAdd} disabled={!value}>Save</Button>
        </div>
      </CardContent>
    </Card>
  );
}
