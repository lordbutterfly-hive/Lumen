import { Metadata } from 'next';
import React, { PropsWithChildren } from 'react';
import { notFound } from 'next/navigation';
import { getPostCached } from '@/blog/lib/cached-api';
import { liteEntryForPermlinkCached } from '@/blog/lib/lite/render/lite-entry-cached';
import { liteRecordExists } from '@/blog/lib/lite/render/lite-entry';
import { getLiteSession } from '@/blog/lib/lite/http/session';
import { isLumenPermlink } from '@/blog/lib/lite/render/lite-post-id';
import { attachLiteIdentities } from '@/blog/lib/lite/render/attach-lite';
import { getObserverFromCookies } from '@/blog/lib/auth-utils';
import { isValidUserParam } from '@/blog/utils/validate-links';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('app');

// Matches app/layout.tsx's SITE_DESC — not imported (that constant isn't
// exported) but kept word-for-word so the error-path fallback here reads as
// the same site, not a second one.
const SITE_DESC =
  'Communities without borders. A social network owned and operated by its users, powered by Hive.';

// ★ NEVER `siteConfig.name` HERE (audit item 15) — see the long note at its
// use below. The root layout's `%s - Lumen` template turns the bare site name
// into "Lumen - Lumen" in the tab.
const FALLBACK_TITLE = 'Post';

/**
 * ★ SECOND, INDEPENDENT COPY of the entity/markup strip this page's
 * `<title>`/`<h1>` and meta description need (2026-08-13, audit O6 item 2 —
 * meta half). `getPostSummary` (`lib/utils.ts`) is the reader-facing
 * card/dek cleaner and belongs to a different agent's pass over this
 * codebase; nothing on THIS path (`<title>`, og:*, twitter:*,
 * meta[name=description]) ever called it, so raw `<i class="twa…">` tags,
 * `![alt](url)` markdown image syntax, and un-decoded HTML entities shipped
 * straight to the browser tab, Twitter, Facebook, Slack and Google for any
 * post whose title/description was written by a client that produces them
 * that way (confirmed live, byte for byte on chain: `don&#039;t stop
 * journey`). Deliberately self-contained rather than importing from
 * `lib/utils.ts`, so this route's output does not depend on the timing or
 * final shape of that separate fix.
 *
 * Three entity families were observed live and all three are handled here:
 * numeric decimal (`&#039;`), numeric hex (`&#x27;`), and named — both ones
 * a hand-rolled map is likely to already have (`&acute;`) and ones it is
 * likely to still be missing (`&rsquo;`). A short table covers the common
 * ones; anything not in it is left as-is rather than silently dropped.
 */
const NAMED_ENTITY_DECODE_TABLE: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  trade: '™',
  acute: '´',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === '#') {
      const codePoint =
        entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      // ★ RANGE-GUARDED, NOT JUST FINITE (2026-08-13). `Number.isFinite` alone lets
      // an out-of-range code point through and `String.fromCodePoint` THROWS on it —
      // `&#1114112;`, `&#x110000;` and `&#99999999999999999999;` all do. Any Hive
      // account can put those bytes in a title, and the throw was swallowed by the
      // outer try/catch in `generateMetadata`, so the post silently lost its title,
      // `og:image`, `og:url` and twitter card: every share preview and search
      // snippet dead, one logged error per crawl.
      //
      // The sibling decoder in `lib/utils.ts` — written in the same pass — already
      // has this guard AND a comment saying it must never throw. This copy was made
      // deliberately self-contained and dropped exactly that line. Same bug, one
      // file apart.
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITY_DECODE_TABLE[entity] ?? match;
  });
}

/**
 * Strips markdown image/link syntax and raw HTML tags a `json_metadata`
 * title/summary can carry (written by other Hive front ends, not by
 * Lumen), then decodes entities LAST so a decoded `&lt;` is never
 * re-interpreted as the start of a tag.
 */
function cleanForMeta(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]*>/g, '')
      // ★ MARKDOWN THAT IS NOT A LINK OR A TAG (2026-08-13). Only links, images and
      // HTML were being stripped, so a post opening with a heading shipped its `##`
      // straight into `og:description` — measured on 2 of 30 real posts. These are
      // line-leading or wrapping markers, invisible to the three rules above.
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
      .replace(/^\s{0,3}>\s?/gm, '') // block quotes
      .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '') // list bullets and numbers
      .replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, '') // horizontal rules
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1') // inline code and fences
      .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
      .replace(/(\*|_)(?=\S)(.*?)(?<=\S)\1/g, '$2') // italic
  )
    .replace(/\s+/g, ' ')
    .trim();
}

export async function generateMetadata({
  params
}: {
  params: { param: string; p2: string; permlink: string };
}): Promise<Metadata> {
  // p2 should start with @ or %40 for valid post URLs - skip metadata fetch for invalid URLs
  if (!isValidUserParam(params?.p2)) {
    return {
      title: 'Not Found',
      description: 'Page not found'
    };
  }
  const author = params.p2.replace('%40', '').replace('@', '');
  const permlink = params?.permlink;
  const observer = await getObserverFromCookies();
  // Same viewer the page uses, so an author's own limited post gets its real title and
  // the cached resolver actually dedupes (it keys on the whole argument list).
  const viewerUserId = (await getLiteSession()).user?.userId;

  try {
    // Use cached version - deduplicated with page's prefetch within the same request
    // Same lite fallback as the page: Hivemind has nothing under a lite display
    // name, so a Lumen post would otherwise get generic "Hive Blog" metadata and
    // share previews. Resolved from the permlink, which identifies the post itself.
    // `.catch(() => null)` matters: for an unknown author the bridge call REJECTS
    // rather than returning null, which would jump straight to the catch below and
    // silently hand back generic "Hive" metadata.
    const post =
      // Same ordering as the page: for a Lumen permlink our own record wins, because
      // the author segment of that URL is a name anyone could have registered on Hive.
      // Share previews are the most valuable thing to hijack, so they must not differ.
      (isLumenPermlink(permlink)
        ? await liteEntryForPermlinkCached(permlink, observer, viewerUserId)
        : null) ??
      // A withheld post of ours gets no preview at all, rather than the chain's answer
      // for a name anyone could have registered.
      (isLumenPermlink(permlink) && (await liteRecordExists(permlink))
        ? null
        : ((await getPostCached(author, permlink, observer).catch(() => null)) ??
          (await liteEntryForPermlinkCached(permlink, observer, viewerUserId))));

    // On the raw on-chain URL — the one every other Hive front end links — the post
    // arrives unresolved: the shared publishing account, and the "RE: <container>"
    // title Hivemind synthesises for any comment. A crawler never runs JavaScript, so
    // unlike the page itself this cannot be corrected later: whatever is emitted here
    // is what every share preview and search result shows, forever.
    if (post && !post._lite) await attachLiteIdentities([post]);

    // ★ NOT `siteConfig.name` WHEN THERE IS NO REAL TITLE (audit item 15). A
    // Hive COMMENT's own `title` field is conventionally empty (only the
    // top-level post carries one), and a Lumen post that has not indexed yet
    // resolves with no post at all — both fell into this branch before, and
    // the root layout's `%s - Lumen` template turned the bare site name into
    // "Lumen - Lumen" in the tab for what is, on this route, an ordinary and
    // frequent case, not an error. Also dropped the trailing space `realTitle`
    // used to carry into the template (`"Title  - Lumen"`, doubled).
    const realTitle = post?._lite?.title || post?.title;
    // `cleanForMeta` can legitimately return '' (a title that was ALL
    // markup/entities) — fall through to FALLBACK_TITLE in that case too,
    // same as the pre-existing empty-realTitle branch.
    const title = (realTitle && cleanForMeta(realTitle)) || FALLBACK_TITLE;
    // ★ STRIP FIRST, THEN CUT (2026-08-13). The 160-character slice used to happen
    // BEFORE `cleanForMeta`, so the cut could land in the middle of a tag or a
    // markdown link and leave the fragment behind — verified on two real posts: an
    // unclosed `<a href=…>` and a bare `[](https://…` shipped straight into
    // `og:description`, `twitter:description` and Google's snippet, which is the one
    // place this text is read by people who have never seen Lumen.
    //
    // Cleaning the whole body first and cutting the cleaned text cannot produce a
    // fragment, because there is no markup left to cut through. The extra work is
    // bounded — this runs once per post render, server-side, not per card.
    const rawDescription =
      post?.json_metadata?.summary || post?.json_metadata?.description || post?.body || '';
    const description = cleanForMeta(rawDescription).slice(0, 160).trimEnd();
    const image =
      post?.json_metadata?.image?.[0] ||
      post?.json_metadata?.images?.[0] ||
      'https://hive.blog/images/hive-blog-share.png';

    return {
      title,
      description,
      openGraph: {
        title,
        description,
        images: [image]
      },
      twitter: {
        card: 'summary_large_image',
        title,
        description,
        images: [image]
      }
    };
  } catch (error) {
    logger.error(error, 'Error in generateMetadata');
    return {
      title: FALLBACK_TITLE,
      description: SITE_DESC,
      openGraph: {
        title: FALLBACK_TITLE,
        description: SITE_DESC
      }
    };
  }
}

export default async function Layout({
  children,
  params
}: PropsWithChildren<{ params: { param: string; p2: string; permlink: string } }>) {
  // Validate p2 param - must start with @ or %40 for valid post URLs
  if (!isValidUserParam(params?.p2)) {
    notFound();
  }

  return <>{children}</>;
}
