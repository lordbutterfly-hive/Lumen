import type { MetadataRoute } from 'next';

/**
 * Crawling policy: OPEN, deliberately (owner decision, 2026-08-28).
 *
 * "We will not block automated fetches. AI is welcome."
 *
 * There was no robots.txt at all before this, which already meant everything was
 * allowed — but by accident rather than on purpose, and a default nobody wrote down
 * is a default the next framework upgrade is free to change. This states it.
 *
 * The named agents below are all already covered by the `*` rule. They are listed
 * because the AI crawlers in particular are blocked by default in a lot of hosting
 * templates and CDN rule sets, and an explicit Allow is what survives someone later
 * turning on a "block AI scrapers" toggle at the edge without reading this file.
 *
 * This is consistent with what the Privacy Policy tells users under "Crawlers,
 * search engines and AI": public posts here are public, and the same content is on
 * the Hive blockchain where anyone can read it regardless of what we serve.
 *
 * Not disallowed, and worth being explicit about why: `/api/` is left crawlable
 * because every route under it either requires a session or is already a public
 * read. Nothing there is protected BY being unlisted, and a Disallow line is not an
 * access control — it only tells honest crawlers where to look.
 */
const AI_AGENTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-Web',
  'anthropic-ai',
  'PerplexityBot',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
  'Amazonbot',
  'meta-externalagent',
  'cohere-ai',
  'Diffbot',
  'omgili'
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      { userAgent: AI_AGENTS, allow: '/' }
    ]
  };
}
