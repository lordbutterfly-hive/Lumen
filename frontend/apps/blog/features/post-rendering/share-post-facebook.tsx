import { Facebook } from 'lucide-react';
import { useTranslation } from '@/blog/i18n/client';
import { blogUrl } from '@hive/ui/config/public-vars';

export default function FacebookShare({ url }: { url: string }) {
  const { t } = useTranslation('common_blog');
  const href = blogUrl(url);
  const openWindow = () => {
    return window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${href}`,
      'fbshare',
      'width=600, height=400, scrollbars=no'
    );
  };
  return (
    // ★ KEYBOARD-UNREACHABLE TRIGGER FIX (2026-08-13, O5 a11y build map item 2).
    // Was a bare `<div onClick>` — no role, no tabindex, unreachable by
    // keyboard (measured live: `tabIndex=-1` at every level of the DOM
    // chain). Same defect, all four social triggers, none previously
    // reported. `title` (hover-only, not consistently announced) becomes a
    // real `aria-label`.
    <button
      type="button"
      className="cursor-pointer text-muted-foreground transition-colors hover:text-destructive"
      onClick={openWindow}
      aria-label={t('post_content.footer.share_on') + `Facebook`}
      data-testid="share-on-facebook"
    >
      <Facebook className="h-[18px] w-[18px]" />
    </button>
  );
}
