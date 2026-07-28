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
        : (await getPostCached(author, permlink, observer).catch(() => null)) ??
          (await liteEntryForPermlinkCached(permlink, observer, viewerUserId)));

    // On the raw on-chain URL — the one every other Hive front end links — the post
    // arrives unresolved: the shared publishing account, and the "RE: <container>"
    // title Hivemind synthesises for any comment. A crawler never runs JavaScript, so
    // unlike the page itself this cannot be corrected later: whatever is emitted here
    // is what every share preview and search result shows, forever.
    if (post && !post._lite) await attachLiteIdentities([post]);

    const realTitle = post?._lite?.title || post?.title;
    const title = realTitle ? `${realTitle} ` : 'Hive Blog';
    const description =
      post?.json_metadata?.summary ||
      post?.json_metadata?.description ||
      (post?.body ? post.body.substring(0, 160) : '');
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
      title: 'Hive',
      description: 'Hive: Communities Without Borders.',
      openGraph: {
        title: 'Hive',
        description: 'Hive: Communities Without Borders.'
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
