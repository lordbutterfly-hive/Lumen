import BadDomains from '@hiveio/hivescript/bad-domains.json';
import GoodDomains from '@hiveio/hivescript/good-domains.json';

/**
 * Does this URL look like a phishing attempt?
 *
 * Use toLowerCase() instead of toLocaleLowerCase() for consistent behavior
 * regardless of server locale. toLocaleLowerCase() with Turkish locale
 * converts 'I' to 'ı' (dotless i), not 'i', which could allow phishing
 * domains to bypass detection.
 *
 * @param {string} questionableUrl
 * @returns {boolean}
 */
// eslint-disable-next-line import/prefer-default-export
export const looksPhishy = (questionableUrl: string) => {
  const lowercaseUrl = questionableUrl.toLowerCase();
  // eslint-disable-next-line no-restricted-syntax
  for (const domain of BadDomains) {
    if (lowercaseUrl.indexOf(domain) > -1) return true;
  }
  return false;
};

/**
 * ★★★ MATCH THE HOSTNAME, NOT A STRING PREFIX (2026-08-13).
 *
 * This stripped the scheme and asked `cleanUrl.startsWith(domain)`. A prefix is not
 * a host, so anybody who registers a lookalike defeated the external-link warning
 * outright. Proven against the real 101-entry list:
 *
 *   https://hive.blog.evil.com/steal   -> whitelisted via "hive.blog"
 *   https://peakd.com.attacker.io/     -> whitelisted via "peakd.com"
 *
 * Both skipped the "you are about to leave this app" interstitial entirely — which
 * is the one control standing between a reader and a link a stranger put in a post.
 * Neither `looksPhishy` nor `isPseudoLocalUrl` catches this shape either.
 *
 * Now: parse the URL and compare hosts, allowing a genuine subdomain (`api.hive.blog`
 * matches `hive.blog`) but never a longer registrable name that merely begins with
 * one. Verified every one of the 101 entries is a bare host with no path, so nothing
 * in the list depended on the old prefix behaviour. Anything unparseable is treated
 * as NOT whitelisted — failing closed here costs one extra confirmation dialog, and
 * failing open costs a reader their keys.
 */
export const isUrlWhitelisted = (url: string) => {
  let host: string;
  try {
    host = new URL(url, 'https://invalid.example').hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || host === 'invalid.example') return false;

  return GoodDomains.some((entry) => {
    const domain = entry.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!domain) return false;
    return host === domain || host.endsWith(`.${domain}`);
  });
};
