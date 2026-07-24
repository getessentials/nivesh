export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: err.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Response(JSON.stringify({ error: message }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Same as `errorResponse`, but for the one Edge Function reachable by a user JWT (monthly-run) —
 * an `HttpError` is a deliberately user-facing message (validation, auth) and passes through
 * unchanged, but any OTHER exception (a raw Postgres error, an internal bug) is logged
 * server-side and replaced with a generic message, matching the deliberate truncation/
 * sanitization docs/09 §5 requires for `job_runs.error` — a JWT-authenticated caller shouldn't
 * see more internal detail than an admin-only diagnostic surface does.
 */
export function userFacingErrorResponse(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err);
  console.error('unexpected error in a user-JWT-reachable function:', err);
  return new Response(JSON.stringify({ error: 'something went wrong, please try again' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}
