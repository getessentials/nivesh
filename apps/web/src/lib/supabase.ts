/**
 * Single Supabase client for the browser — ANON key only (docs/09 §3: the service-role key must
 * never reach client code). Every table this app reads/writes is RLS-scoped to `auth.uid()`
 * (docs/09 §1); this client carries the signed-in user's JWT automatically once authenticated.
 */
import { createClient, FunctionsHttpError } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  throw new Error(
    'Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy .env.example to .env and fill in your Supabase project values.'
  );
}

export const supabase = createClient(url, anonKey);

/**
 * Calls a deployed Edge Function under the user's own session (Authorization header attached
 * automatically) — used for monthly-run "Run now" (docs/09 §2.2). Returns the parsed JSON body
 * EVEN on a non-2xx response (e.g. monthly-run's 409 "needsConfirmation" payload, or a 429 rate
 * limit) — supabase-js otherwise only exposes the raw Response via `error.context`, discarding
 * the structured body the function actually returned.
 */
export async function invokeFunction<T>(name: string, body?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(name, { body });
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const parsed = await error.context.json().catch(() => null);
      if (parsed) return parsed as T;
    }
    throw error;
  }
  return data as T;
}
