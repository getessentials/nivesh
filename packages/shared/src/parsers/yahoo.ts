/**
 * Parser for Yahoo Finance's unofficial chart API response (docs/02 §1), used for `.NS`
 * exchange-price ingestion. Pure — the caller does the fetch (with backoff/UA-rotation/IST
 * session handling per docs/02 §1) and hands this module the parsed JSON body.
 *
 * IST session handling: Yahoo's daily-bar timestamps are unix seconds that can land within a
 * few hours of UTC midnight; shifting by +5:30 before taking the UTC calendar date reliably
 * buckets each bar into its correct NSE trading day.
 */

export interface YahooBar {
  /** 'YYYY-MM-DD', IST trading day */
  date: string;
  /** decimal rupees */
  close: number;
  volume: number | null;
}

export interface YahooChartParseResult {
  symbol: string | null;
  longName: string | null;
  bars: YahooBar[];
}

const IST_OFFSET_SECONDS = 5.5 * 3600;

function unixSecondsToIstDate(t: number): string {
  return new Date((t + IST_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

export function parseYahooChart(json: unknown): YahooChartParseResult {
  const root = json as {
    chart?: {
      result?: Array<{
        meta?: { symbol?: string; longName?: string; shortName?: string };
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[]; volume?: (number | null)[] }> };
      }>;
      error?: unknown;
    };
  };

  const result = root.chart?.result?.[0];
  if (!result) {
    throw new Error('Yahoo chart response has no result (symbol not found or endpoint error)');
  }

  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const volumes = quote?.volume ?? [];

  const bars: YahooBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || !Number.isFinite(close)) continue; // holiday gap / incomplete bar
    bars.push({
      date: unixSecondsToIstDate(timestamps[i]!),
      close,
      volume: volumes[i] ?? null,
    });
  }

  return {
    symbol: result.meta?.symbol ?? null,
    longName: result.meta?.longName ?? result.meta?.shortName ?? null,
    bars,
  };
}
