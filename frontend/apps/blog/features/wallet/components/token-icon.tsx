import Image from 'next/image';

const SRC = {
  HIVE: '/images/wallet/hive-logo.png',
  HBD: '/images/wallet/hbd-logo.png',
  // The same Bitcoin mark the sign-in screen already uses (lumen-login.tsx,
  // wallet-connect-dialog.tsx); added 2026-09-08 for the wallet's Magi tab.
  BTC: '/logos/bitcoin.png'
} as const;

export type TokenIconCurrency = keyof typeof SRC;

/** Real Hive / HBD / BTC marks (from the design handoff), used on every token tile. */
export default function TokenIcon({ currency, size = 44 }: { currency: TokenIconCurrency; size?: number }) {
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
