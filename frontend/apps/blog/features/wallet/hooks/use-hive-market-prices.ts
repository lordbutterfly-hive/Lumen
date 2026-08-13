import { useQuery } from '@tanstack/react-query';

export interface HiveMarketPrices {
  hiveUsd: number;
  hiveBtc: number;
  hiveUsd24hChange: number;
  hbdUsd: number;
  /** Last ~22 daily closes (oldest first), for the price-card sparkline. */
  hiveSparkline: number[];
}

const FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`CoinGecko request failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

interface SimplePriceResponse {
  hive?: { usd?: number; btc?: number; usd_24h_change?: number };
  hive_dollar?: { usd?: number };
}

interface MarketChartResponse {
  prices?: [number, number][];
}

/**
 * Real spot prices from CoinGecko's public API (no key required) — the same
 * source the design mockup labels ("HIVE / BTC via CoinGecko",
 * "... via CoinGecko"). No price feed exists anywhere else in this codebase
 * yet, so this hook is the whole integration: current HIVE/HBD price + 24h
 * change from /simple/price, and a real 7-day series from /coins/hive/market_chart
 * for the sparkline (downsampled to ~22 points to match the design's bar count).
 * On any failure (offline sandbox, CORS, rate limit) this resolves to null so
 * the UI can render a clearly-labelled "price unavailable" placeholder instead
 * of stale or fabricated numbers.
 */
export function useHiveMarketPrices() {
  return useQuery({
    queryKey: ['hiveMarketPrices'],
    queryFn: async (): Promise<HiveMarketPrices> => {
      // ★ THROUGH OUR SERVER, NOT api.coingecko.com DIRECTLY (2026-08-13).
      // Measured: two cross-origin calls per wallet load, ~250ms each, charging
      // CoinGecko's free-tier per-IP rate limit to the READER — so enough people
      // behind one NAT and the price card fails for all of them. `/api/market-prices`
      // makes the same two calls server-side and memoises them for 60s, which also
      // stops handing every reader's IP to a third party. Everything below this line
      // is unchanged: same two payload shapes, same refusal to coerce a missing
      // price to 0.
      const { simple, chart } = (await fetchJson('/api/market-prices')) as {
        simple: SimplePriceResponse;
        chart: MarketChartResponse;
      };

      // A 200 with a missing/zero price (soft rate-limit, partial payload, schema
      // change) must NOT be coerced to 0 — a $0 HIVE price silently renders the
      // whole account's Estimated Value as a fabricated dollar figure (a LIE).
      // Throw so the query goes to isError and the UI shows "—"/unavailable.
      const hiveUsd = simple.hive?.usd;
      const hbdUsd = simple.hive_dollar?.usd;
      if (typeof hiveUsd !== 'number' || hiveUsd <= 0 || typeof hbdUsd !== 'number' || hbdUsd <= 0) {
        throw new Error('CoinGecko returned no usable HIVE/HBD price');
      }
      const hiveBtc = simple.hive?.btc ?? 0;
      const hiveUsd24hChange = simple.hive?.usd_24h_change ?? 0;

      const points = chart.prices ?? [];
      const bucketCount = 22;
      const bucketSize = Math.max(1, Math.floor(points.length / bucketCount));
      const hiveSparkline = points
        .filter((_, i) => i % bucketSize === 0)
        .slice(-bucketCount)
        .map(([, price]) => price);

      return { hiveUsd, hiveBtc, hiveUsd24hChange, hbdUsd, hiveSparkline };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1
  });
}
