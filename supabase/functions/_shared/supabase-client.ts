/**
 * Ingestion functions always act as service_role (they write reference/market tables no
 * client role may touch — docs/09 §1). The service-role key lives only in Edge Function
 * secrets (docs/09 §3), never in the client bundle or SQL.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from './env.ts';

export function createServiceClient(): SupabaseClient {
  const url = requireEnv('SUPABASE_URL');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, key, { auth: { persistSession: false } });
}
