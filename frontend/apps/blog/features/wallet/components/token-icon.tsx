import Image from 'next/image';

const SRC = {
  HIVE: '/images/wallet/hive-logo.png',
  HBD: '/images/wallet/hbd-logo.png'
} as const;

/** Real Hive / HBD marks (from the design handoff), used on every token tile. */
export default function TokenIcon({ currency, size = 44 }: { currency: 'HIVE' | 'HBD'; size?: number }) {
  return (
    <Image
      src={SRC[currency]}
      alt={currency}
      width={size}
      height={size}
      className="rounded-full"
      style={{ width: size, height: size }}
    />
  );
}
