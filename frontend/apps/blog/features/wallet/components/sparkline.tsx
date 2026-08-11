/**
 * Small bar sparkline for the HIVE price card. Renders real 7-day CoinGecko
 * closes when available (see hooks/use-hive-market-prices.ts); the caller is
 * responsible for not rendering this when data hasn't loaded.
 *
 * ★ W-5: the bars were #e0b24d — amber, the colour family already rejected for
 * the hero, and a fifth accent on a page that only has one. They are the brand
 * red at half strength: quiet enough not to compete with the price figure above
 * them, and unmistakably the same palette as the rest of Lumen. Half strength
 * also keeps it clear of the card's own +/- change chip, which is the element
 * that carries direction; these seven bars carry shape, not good or bad news.
 */
const BAR_FILL = '#c0392b';
const BAR_OPACITY = 0.5;
export default function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;

  const width = 300;
  const height = 60;
  const gap = 3;
  const barCount = values.length;
  const barWidth = (width - gap * (barCount - 1)) / barCount;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-3 w-full" style={{ height }} aria-hidden>
      {values.map((value, i) => {
        const ratio = (value - min) / range;
        const barHeight = Math.max(2, ratio * height);
        return (
          <rect
            key={i}
            x={i * (barWidth + gap)}
            y={height - barHeight}
            width={barWidth}
            height={barHeight}
            rx={1.5}
            fill={BAR_FILL}
            fillOpacity={BAR_OPACITY}
          />
        );
      })}
    </svg>
  );
}
