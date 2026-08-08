'use client';

import { memo } from 'react';
import { Separator } from '@ui/components/separator';
import { Button } from '@ui/components/button';
import { useTranslation } from '@/blog/i18n/client';
import ImageGallery from './image-gallery';
import RendererContainer from './rendererContainer';
import { postClassName } from '@/blog/features/post-editor/lib/utils';
import { getPostHiddenMessageKey } from '@/blog/lib/muted-reasons';

interface PostBodySectionProps {
  body: string;
  author: string;
  permlink: string;
  mainPost: boolean;
  crossPostBody?: string;
  mutedPost: boolean;
  mutedReasons?: number[];
  onShowMutedContent: () => void;
  /** True when this post is NSFW-flagged AND the reader has not asked to see it. */
  nsfwHidden?: boolean;
  onShowNsfwContent?: () => void;
}

/**
 * Memoized component for rendering the post body content.
 * This prevents unnecessary re-renders when the parent's reply state changes.
 */
const PostBodySection = memo(function PostBodySection({
  body,
  author,
  permlink,
  mainPost,
  crossPostBody,
  mutedPost,
  mutedReasons,
  onShowMutedContent,
  nsfwHidden = false,
  onShowNsfwContent
}: PostBodySectionProps) {
  const { t } = useTranslation('common_blog');

  // ★ THE POST PAGE HAD NO NSFW GATE AT ALL (2026-08-09).
  //
  // The feed card, topic pages and the profile Posts tab all honour the
  // reader's `hide`/`warn`/`show` preference — and every one of them links
  // HERE, where it was ignored outright. Measured on a flagged post: 21 `<img>`
  // elements and 24 real image requests, at every preference value, signed in
  // and signed out. So the preference protected the reader right up until they
  // clicked, which is the one moment it mattered.
  //
  // Deliberately placed ABOVE the render (not as an overlay) so the body is
  // never handed to the renderer and its images are never requested — the same
  // reasoning as the card's placeholder. Reuses the muted-post gate's shape
  // because this page already teaches that "hidden content + a button to show
  // it" grammar, and a second visual language for the same idea would be worse.
  if (nsfwHidden) {
    return (
      <>
        <Separator />
        <div className="my-8 flex items-center justify-between text-destructive" data-testid="post-nsfw-gate">
          {t('post_content.body.nsfw_hidden', {
            defaultValue: 'This post is marked NSFW.'
          })}
          <Button variant="outlineRed" onClick={onShowNsfwContent} data-testid="post-nsfw-show">
            {t('post_content.body.show')}
          </Button>
        </div>
      </>
    );
  }

  if (mutedPost) {
    return (
      <>
        <Separator />
        <div className="my-8 flex items-center justify-between text-destructive">
          {t(getPostHiddenMessageKey(mutedReasons))}
          <Button variant="outlineRed" onClick={onShowMutedContent}>
            {t('post_content.body.show')}
          </Button>
        </div>
      </>
    );
  }

  return (
    <ImageGallery>
      <RendererContainer
        mainPost={mainPost}
        body={crossPostBody ?? body}
        author={author}
        permlink={permlink}
        className={postClassName}
      />
    </ImageGallery>
  );
});

export default PostBodySection;
