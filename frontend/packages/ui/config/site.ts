import env from '@beam-australia/react-env';

import { configuredApiEndpoint, configuredSiteDomain } from '@hive/ui/config/public-vars';

const SERVER_VAR_PREFIX = 'DENSER_SERVER_';

const MAINNET_CHAIN_ID = 'beeab0de00000000000000000000000000000000000000000000000000000000';
const MIRRORNET_CHAIN_ID = '42';

export type ChainEnv = 'mainnet' | 'mirrornet' | 'testnet';

const chainEnv: Record<string, ChainEnv> = {
  [MAINNET_CHAIN_ID]: 'mainnet',
  [MIRRORNET_CHAIN_ID]: 'mirrornet',
  'testnet': 'testnet'
};

const chainId = env('CHAIN_ID') ? env('CHAIN_ID') : MAINNET_CHAIN_ID;
export const siteConfig = {
  name: 'Lumen',
  url: configuredSiteDomain,
  endpoint: configuredApiEndpoint,
  chainId,
  chainEnv: chainEnv[chainId] || chainEnv['testnet'],
  ogImage: '',
  description: 'Social media site for Hive Blockchain',
  links: {
    twitter: '/',
    github: '/'
  },
  allowNonStrictLogin: env('ALLOW_NON_STRICT_LOGIN') === 'yes' ? true : false,
  loginAuthenticateOnBackend: env('LOGIN_AUTHENTICATE_ON_BACKEND') === 'yes' ? true : false,

  googleDrive: {
    clientId: env('GOOGLE_DRIVE_CLIENT_ID') || '',
    walletFileName: env('GOOGLE_DRIVE_WALLET_FILE_NAME') || 'hivebridge_wallet.json',
    scopes: [
      'https://www.googleapis.com/auth/drive.appdata'
    ].join(' '),
    redirectUri: 'postmessage', // Using 'postmessage' to prevent reloading the page
  },

  // OAUTH server
  oidcEnabled: process.env[`${SERVER_VAR_PREFIX}OIDC_ENABLED`] === 'yes' ? true : false,
  oidcUrlPrefix: process.env[`${SERVER_VAR_PREFIX}OIDC_URL_PREFIX`] || '/oidc',
  oidcInteractionUrlPrefix: process.env[`${SERVER_VAR_PREFIX}OIDC_INTERACTION_URL_PREFIX`] || '/interaction',
  oidcCookiesKeys: process.env[`${SERVER_VAR_PREFIX}OIDC_COOKIES_KEYS`]
    ? (process.env[`${SERVER_VAR_PREFIX}OIDC_COOKIES_KEYS`] as string).split(' ')
    : [],
  oidcClients: process.env[`${SERVER_VAR_PREFIX}OIDC_CLIENTS`] || '[]',
  oidcJwksKeys: process.env[`${SERVER_VAR_PREFIX}OIDC_JWKS_KEYS`] || '[]',
};

export type SiteConfig = typeof siteConfig;
