import env from '@beam-australia/react-env';

/**
 * Reblog comments in the UI (quote reblog spec v2): off unless
 * `REACT_APP_QUOTE_REBLOGS=yes`. One reader for the server components and the client,
 * so the profile's server-rendered first page and the client's paging can never
 * disagree about which stream they are reading. The server's writes have their own
 * switch (`LITE_QUOTE_REBLOGS_ENABLED`).
 */
export function quoteReblogsEnabled(): boolean {
  return env('QUOTE_REBLOGS') === 'yes';
}
