import { Twitter } from 'lucide-react';
import { useTranslation } from '@/blog/i18n/client';
import { blogUrl } from '@ui/config/public-vars';

export default function TwitterShare({ title, url }: { title: string; url: string }) {
  const { t } = useTranslation('common_blog');
  const href = blogUrl(url);
  const postTitle = title + ' | ' + 'Hive';
  const winWidth = 640;
  const winHeight = 320;
  const winTop = 0;
  const winLeft = 0;
  const q = 'text=' + encodeURIComponent(postTitle) + '&url=' + encodeURIComponent(href);
  const openWindow = () => {
    // ★ DEFECT FIX (2026-08-17): was `http://twitter.com/...` — the only one
    // of the four share popups (Facebook/LinkedIn/Reddit all use `https://`)
    // opening an insecure connection to build the share intent.
    return window.open(
      'https://twitter.com/share?' + q,
      'Share',
      'top=' + winTop + ',left=' + winLeft + ',toolbar=0,status=0,width=' + winWidth + ',height=' + winHeight
    );
  };
  return (
    // ★ KEYBOARD-UNREACHABLE TRIGGER FIX (2026-08-13, O5 a11y build map item 2).
    // See share-post-facebook.tsx for the shared reasoning.
    <button
      type="button"
      className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
      onClick={openWindow}
      aria-label={t('post_content.footer.share_on') + `Twitter`}
      data-testid="share-on-twitter"
    >
      <Twitter className="h-[18px] w-[18px]" />
    </button>
  );
}
