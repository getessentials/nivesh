/**
 * fetch wrapper with backoff+jitter and UA rotation (docs/02 §1 "reuse that client (backoff,
 * UA rotation, IST session handling)"; docs/07 ENG-3: "Yahoo blocks data-center IPs more
 * aggressively than residential ... ingesters retry with jitter").
 */

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
];

export interface FetchWithRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** Per-attempt timeout; a stalled connection must fail fast into the backoff cycle rather
   *  than occupying the whole Edge Function wall-clock budget (docs/10 §8). Default 20s. */
  timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUSES = new Set([403, 429]); // 403 is Yahoo/NSE's bot-blocking response —
// exactly the failure mode UA rotation exists to survive by retrying with a different UA.

/**
 * Retries on network errors and 403/429/5xx responses (exponential backoff + full jitter,
 * rotating User-Agent per attempt). A non-retryable 4xx is returned as-is (not thrown) — the
 * caller decides whether e.g. a 404 is fatal or just means "no data today".
 */
export async function fetchWithRetry(url: string, opts: FetchWithRetryOptions = {}): Promise<Response> {
  const { maxAttempts = 4, baseDelayMs = 500, headers = {}, method, body, timeoutMs = 20_000 } = opts;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length]!;
    try {
      const res = await fetch(url, {
        method, body, headers: { 'User-Agent': ua, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok || (res.status < 500 && !RETRYABLE_STATUSES.has(res.status))) return res;
      lastErr = new Error(`HTTP ${res.status} from ${url}`);
    } catch (e) {
      lastErr = e;
    }
    if (attempt < maxAttempts - 1) {
      const delay = baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetchWithRetry: exhausted attempts for ${url}`);
}
