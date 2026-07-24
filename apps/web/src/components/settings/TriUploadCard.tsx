import { useState } from 'react';
import { toast } from 'sonner';
import { useGetIndicesQuery } from '@/store/api';
import { invokeFunction } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** Owner-admin manual TRI CSV upload (docs/02 §3) — the first-class path while niftyindices'
 *  endpoints are unreachable. One file = one index's history; server re-validates schema and the
 *  same day-over-day sanity gate every automated ingester uses (docs/09 §5). */
export function TriUploadCard() {
  const { data: indices } = useGetIndicesQuery();
  const triIndices = (indices ?? []).filter((i) => i.tri_source === 'niftyindices');

  const [indexName, setIndexName] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [csvText, setCsvText] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setCsvText(await file.text());
  }

  async function handleUpload() {
    if (!indexName || !csvText) return;
    setUploading(true);
    try {
      const result = await invokeFunction<{ ok?: boolean; error?: string; rowsWritten?: number; dateRange?: { from: string; to: string } }>(
        'admin-upload-tri',
        { indexName, csvText }
      );
      if (result.error) {
        toast.error(result.error);
      } else {
        toast.success(`${result.rowsWritten} row(s) written for ${indexName} (${result.dateRange?.from} → ${result.dateRange?.to}).`);
        setCsvText(null);
        setFileName(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'admin-upload-tri request failed.');
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>TRI CSV upload</CardTitle>
        <CardDescription>
          niftyindices' automated feed is currently unreachable — upload a historical-data CSV
          exported from niftyindices.com for one index at a time. Max 1MB, 5,000 rows, UTF-8.
          Every row is validated (no future dates, no &gt;20% day-over-day jump) before anything
          is written — one bad row rejects the whole file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={indexName} onValueChange={setIndexName}>
            <SelectTrigger className="w-64"><SelectValue placeholder="Select index" /></SelectTrigger>
            <SelectContent>
              {triIndices.map((i) => <SelectItem key={i.name} value={i.name}>{i.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <input type="file" accept=".csv,text/csv" onChange={handleFileChange} className="text-sm" />
        </div>
        {fileName && <p className="text-xs text-muted-foreground">{fileName} loaded, ready to upload.</p>}
        <Button onClick={handleUpload} disabled={!indexName || !csvText || uploading}>
          {uploading ? 'Uploading…' : 'Upload'}
        </Button>
      </CardContent>
    </Card>
  );
}
