import type { CreatorTokenSummary } from './types';

/**
 * Placeholder market data for the redesign token screens until the contract is
 * deployed and the indexer serves live reads. Shapes match the real bonding-curve
 * view-model (USD + tokens, price/cap/floor); values are illustrative but
 * internally plausible (cap ≈ supply × price, completion ≈ answered / total).
 *
 * TODO(live): replace with an indexer-backed hook (`useCreatorMarkets`) once the
 * contract is deployed — the component API takes CreatorTokenSummary[], so the
 * swap is data-only, no UI change.
 */

// 'A'nswered / 'm'issed → boolean marks, newest last.
const marks = (s: string): boolean[] => s.split('').map((c) => c === 'A');

export const MOCK_CREATORS: CreatorTokenSummary[] = [
  {
    handle: 'delm',
    what: 'Witness ops & infra',
    avatarColor: 'linear-gradient(135deg,#c0392b,#e07b3e)',
    fromPriceUsd: 25,
    priceUsd: 9.8,
    marketCapUsd: 196000,
    delivery: { answered: 128, total: 130, completionPct: 98, typicalResponse: '~2h', marks: marks('AAAAAAAAAAAA'), available: true }
  },
  {
    handle: 'ada',
    what: 'Hive core-dev',
    avatarColor: 'linear-gradient(135deg,#3182ce,#4f9e6a)',
    fromPriceUsd: 10,
    priceUsd: 4.2,
    marketCapUsd: 84000,
    delivery: { answered: 47, total: 52, completionPct: 90, typicalResponse: '~6h', marks: marks('AAAAmAAAAmAA'), available: true }
  },
  {
    handle: 'favour',
    what: 'Growth & newsletters',
    avatarColor: '#e07b3e',
    fromPriceUsd: 15,
    priceUsd: 6.1,
    marketCapUsd: 122000,
    delivery: { answered: 61, total: 63, completionPct: 97, typicalResponse: '~4h', marks: marks('AAAAAAmAAAAA'), available: true }
  },
  {
    handle: 'quill',
    what: 'Technical writing',
    avatarColor: '#3182ce',
    fromPriceUsd: 12,
    priceUsd: 5.4,
    marketCapUsd: 108000,
    delivery: { answered: 84, total: 88, completionPct: 95, typicalResponse: '~9h', marks: marks('AAAAAAAAAmAA'), available: true }
  },
  {
    handle: 'sora',
    what: 'Travel & film',
    avatarColor: '#2f7d4f',
    fromPriceUsd: 6,
    priceUsd: 2.3,
    marketCapUsd: 46000,
    delivery: { answered: 12, total: 18, completionPct: 67, typicalResponse: '~1d', marks: marks('AAmAmAAmAAmA'), available: true }
  },
  {
    handle: 'rune',
    what: 'Game design',
    avatarColor: '#4a5568',
    fromPriceUsd: 18,
    priceUsd: 3.9,
    marketCapUsd: 78000,
    // Delivery record couldn't load — rendered as "unavailable", NOT rank-boosted.
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: false }
  }
];

export const MOCK_NEW_CREATORS: CreatorTokenSummary[] = [
  {
    handle: 'bewhale',
    what: 'DeFi strategy',
    avatarColor: '#805ad5',
    fromPriceUsd: 5,
    priceUsd: 1.0,
    marketCapUsd: 5000,
    isNew: true,
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: true }
  },
  {
    handle: 'kestrel',
    what: 'Photography',
    avatarColor: '#dd6b20',
    fromPriceUsd: 8,
    priceUsd: 1.0,
    marketCapUsd: 8000,
    isNew: true,
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: true }
  },
  {
    handle: 'nomad.dev',
    what: 'Rust & smart contracts',
    avatarColor: '#0d9488',
    fromPriceUsd: 12,
    priceUsd: 1.0,
    marketCapUsd: 12000,
    isNew: true,
    delivery: { answered: 0, total: 0, completionPct: 0, typicalResponse: '', marks: [], available: true }
  }
];
