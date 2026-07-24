/**
 * CORS for the Edge Functions callable directly from the browser (monthly-run today; any future
 * user-JWT function). Origin is wildcarded deliberately — auth is the bearer JWT verified in
 * auth.ts, not cookies, so a permissive Access-Control-Allow-Origin carries no session risk.
 */
export const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/** Preflight short-circuit — must run before any auth check, or the OPTIONS request itself
 *  gets rejected (missing bearer token) with no CORS headers, which browsers surface as a
 *  CORS error rather than the real 401. */
export function handlePreflight(req: Request): Response | null {
  return req.method === 'OPTIONS' ? new Response(null, { status: 204, headers: CORS_HEADERS }) : null;
}

export function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, headers });
}
