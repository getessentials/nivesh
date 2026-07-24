/** Reads back the `feedback_scores` rows stage-theme-rank persisted this run (docs/03 §5) — a
 *  separate Edge Function invocation has no shared memory with theme-rank, so ETF-rank re-reads
 *  from the DB rather than recomputing. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { FeedbackStatus } from './engine-lib.ts';

export interface EtfFeedback {
  adj: number;
  status: FeedbackStatus;
}

export async function loadEtfFeedback(supabase: SupabaseClient, userId: string, asOf: string): Promise<Map<number, EtfFeedback>> {
  const { data, error } = await supabase
    .from('feedback_scores')
    .select('ref, adj, detail')
    .eq('user_id', userId).eq('scope', 'etf').eq('as_of', asOf);
  if (error) throw new Error(`failed to load etf feedback_scores for user ${userId} as_of ${asOf}: ${error.message}`);

  const map = new Map<number, EtfFeedback>();
  for (const row of data as Array<{ ref: string; adj: string | number; detail: { status?: FeedbackStatus } }>) {
    if (!row.detail?.status) continue;
    map.set(Number(row.ref), { adj: Number(row.adj), status: row.detail.status });
  }
  return map;
}
