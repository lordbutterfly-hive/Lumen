import { useQuery } from '@tanstack/react-query';

export interface HiveMarketPrices {
  hiveUsd: number;
  hiveBtc: number;
  hiveUsd24hChange: number;
  /**
   * What 1 HBD is worth, for valuing balances: Hive's internal market (HIVE
   * price / HBD-per-HIVE of the last trade), CoinGecko only if that read fails.
   * See `fetchInternalMarketTicker` in app/api/market-prices/route.ts.
   */
  hbdUsd: number;
  /** CoinGecko's outside-exchange HBD price, for the HBD card's side note only. Null when absent. */
  hbdExchangeUsd: number | null;
  /**
   * BTC/USD, for Bitcoin held on Magi (wallet Magi tab, 2026-09-08). Null when
   * CoinGecko omits it: the HIVE/HBD cards must not fail because one extra id
   * is missing, and a missing price renders as a dash, never as $0.
   */
  btcUsd: number | null;
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
  bitcoin?: { usd?: number };
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
      const { simple, chart, internal } = (await fetchJson('/api/market-prices')) as {
        simple: SimplePriceResponse;
        chart: MarketChartResponse;
        internal?: { latest?: string } | null;
      };

      // A 200 with a missing/zero price (soft rate-limit, partial payload, schema
      // change) must NOT be coerced to 0 — a $0 HIVE price silently renders the
      // whole account's Estimated Value as a fabricated dollar figure (a LIE).
      // Throw so the query goes to isError and the UI shows "—"/unavailable.
      const hiveUsd = simple.hive?.usd;
      const exchangeRaw = simple.hive_dollar?.usd;
      const hbdExchangeUsd = typeof exchangeRaw === 'number' && exchangeRaw > 0 ? exchangeRaw : null;
      if (typeof hiveUsd !== 'number' || hiveUsd <= 0) {
        throw new Error('CoinGecko returned no usable HIVE price');
      }
      // ★ HBD from the internal market (2026-10-17): CoinGecko had HBD at $2.92
      // off a single halted exchange while it sold for $0.97 on Hive. CoinGecko
      // is now only the fallback, and its absence alone no longer fails the cards
      // (it can drop HBD entirely if that exchange delists it).
      const hbdPerHive = Number(internal?.latest);
      const hbdUsd = Number.isFinite(hbdPerHive) && hbdPerHive > 0 ? hiveUsd / hbdPerHive : hbdExchangeUsd;
      if (hbdUsd === null) {
        throw new Error('No usable HBD price from the internal market or CoinGecko');
      }
      const hiveBtc = simple.hive?.btc ?? 0;
      const btcRaw = simple.bitcoin?.usd;
      const btcUsd = typeof btcRaw === 'number' && btcRaw > 0 ? btcRaw : null;
      const hiveUsd24hChange = simple.hive?.usd_24h_change ?? 0;

      const points = chart.prices ?? [];
      const bucketCount = 22;
      const bucketSize = Math.max(1, Math.floor(points.length / bucketCount));
      const hiveSparkline = points
        .filter((_, i) => i % bucketSize === 0)
        .slice(-bucketCount)
        .map(([, price]) => price);

      return { hiveUsd, hiveBtc, hiveUsd24hChange, hbdUsd, hbdExchangeUsd, btcUsd, hiveSparkline };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: 1
  });
}
