/**
 * Ingestion functions are never user-invokable (docs/09 §2.1) — the only accepted credential is
 * the cron secret, sent by pg_net as header `x-cron-secret` (docs/09 §2.2). Compared in constant
 * time so response-time doesn't leak how much of the secret matched (docs/09 §2.2 fix).
 */
import { createClient } from '@supabase/supabase-js';
import { requireEnv } from './env.ts';
import { HttpError } from './http-error.ts';

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export function verifyCronSecret(req: Request): void {
  const provided = req.headers.get('x-cron-secret');
  const expected = requireEnv('CRON_SECRET');
  if (!provided || !timingSafeEqual(provided, expected)) {
    throw new HttpError(401, 'invalid or missing cron secret');
  }
}

/**
 * User-mode auth (docs/09 §2.2): validates the bearer JWT against Supabase Auth and returns the
 * `sub` claim as `userId` — NEVER read user identity from the request body, or a user could
 * trigger/inspect another user's run by naming their id in the payload.
 */
export async function verifyUserJwt(req: Request): Promise<{ userId: string }> {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, 'missing bearer token');

  const client = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_ANON_KEY'), {
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'invalid or expired session token');
  return { userId: data.user.id };
}
