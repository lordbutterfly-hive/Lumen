'use client';

import { useRef, useEffect, useState, useMemo, memo, MouseEvent as ReactMouseEvent } from 'react';
import Loading from '@ui/components/loading';
import { LeavePageDialog } from './leave-page-dialog';
import { getRenderer, getPreviewRenderer } from './lib/renderer';
import ScrollToElement from './scroll-to-element';
import { cn } from '@ui/lib/utils';
import { isUrlWhitelisted } from '@hive/ui/config/lists/phishing';

/**
 * ★★★ ONE H1 PER POST PAGE (2026-08-11, audit item 8). The post page already
 * renders its own `<h1 data-testid="article-title">` for the post's title
 * (`app/[param]/[p2]/[permlink]/content.tsx`), and a reader's own Markdown can
 * ALSO open with a `#` heading, which this renderer turned into a second raw
 * `<h1>` inside the body — two H1s on one page, which breaks heading-based
 * screen-reader navigation (there is no longer exactly one "most important
 * heading" to land on).
 *
 * Demotes every markdown heading by one level (h1->h2 ... h5->h6; h6 has
 * nowhere lower to go) so the post's own title stays the page's only h1. Pure
 * string substitution on the rendered HTML, done here rather than in the
 * shared `@hive/renderer` package: that package is also used for comments,
 * community descriptions and editor previews, none of which have a
 * page-level h1 to collide with, and rewriting its Remarkable heading rule
 * globally would change heading sizes (via the `prose-hN:` selectors in
 * `postClassName`) everywhere at once. Done on the STRING, not via a
 * post-mount DOM walk, so it runs identically during SSR and on the client —
 * no hydration mismatch, and a crawler with no JS still sees the demoted,
 * single-h1 structure.
 *
 * Processed h5 -> h1 (highest level first) deliberately: each step only ever
 * touches its own original tag name, and by the time a lower step runs, the
 * level it's about to consume can no longer collide with a tag a previous
 * step just produced (previous steps always produce a HIGHER number than any
 * level still to be consumed).
 */
function demoteHeadings(html: string): string {
  let out = html;
  for (let level = 5; level >= 1; level--) {
    const from = `h${level}`;
    const to = `h${level + 1}`;
    out = out
      .replace(new RegExp(`<${from}(?=[\\s>])`, 'g'), `<${to}`)
      .replace(new RegExp(`</${from}>`, 'g'), `</${to}>`);
  }
  return out;
}

const RendererContainer = ({
  body,
  author,
  permlink,
  dataTestid,
  communityDescription,
  mainPost,
  className,
  previewMode,
  proxyAuthToken
}: {
  body: string;
  author: string;
  permlink?: string;
  dataTestid?: string;
  communityDescription?: boolean;
  className?: string;
  mainPost?: Boolean;
  previewMode?: boolean;
  proxyAuthToken?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState('');
  const hiveRenderer = useMemo(
    () => proxyAuthToken
      ? getPreviewRenderer(proxyAuthToken, author)
      : getRenderer(author),
    [proxyAuthToken, author]
  );

  /**
   * ★ EVENT DELEGATION, NOT PER-NODE LISTENERS (2026-08-13, audit O6 item 1).
   *
   * A per-node `addEventListener('click', …)` attached in the mount effect
   * below is destroyed the instant react-dom rewrites this container's
   * `dangerouslySetInnerHTML` body — which it does on every re-render of
   * this component (parent re-renders, this dialog's own `setOpen`, a
   * sibling comment's renderer mounting), while the container `<div>` stays
   * the SAME node so the effect's deps never change and it never re-runs to
   * reattach. Measured: one click on ONE link disarmed the interstitial for
   * EVERY external link on the page, including ones never clicked before.
   *
   * A single React `onClick` on the container is a synthetic listener React
   * itself keeps alive at the root — it does not care how many times the
   * DOM underneath gets rewritten. Resolving the anchor with `closest('a')`
   * at click time (instead of relying on `e.target` being the anchor
   * itself) also fixes the old handler's `anchor.parentElement` fallback,
   * which threw if the click landed more than one level inside the `<a>`
   * (e.g. an `<img>` inside a `<strong>` inside the link).
   */
  const handleBodyClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const anchor = (e.target as Element).closest?.('a') as HTMLAnchorElement | null;
    if (!anchor || !anchor.classList.contains('link-external')) return;
    const href = anchor.href;
    if (!href) return;
    // Whitelisted external links are born with target="_blank" from the
    // renderer's own `addTargetBlankToLinks: true` (lib/renderer.ts) — let
    // them navigate normally instead of intercepting.
    if (isUrlWhitelisted(href)) return;
    e.preventDefault();
    setLink(href);
    setOpen(true);
  };

  const handleYoutubeFacadeClick = (e: Event) => {
    const target = e.currentTarget as HTMLElement;
    const videoId = target.dataset.youtubeId;
    const width = target.dataset.width || '640';
    const height = target.dataset.height || '480';
    if (videoId) {
      const iframe = document.createElement('iframe');
      iframe.width = width;
      iframe.height = height;
      iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1`;
      iframe.setAttribute('allowfullscreen', 'allowfullscreen');
      iframe.setAttribute('allow', 'autoplay; encrypted-media');
      iframe.setAttribute('frameborder', '0');
      target.replaceWith(iframe);
    }
  };

  useEffect(() => {
    const youtubeFacades = ref.current?.querySelectorAll('.youtube-facade');
    if (previewMode) {
      youtubeFacades?.forEach((facade) => {
        facade.addEventListener('click', handleYoutubeFacadeClick);
      });
    } else {
      youtubeFacades?.forEach((facade) => {
        const el = facade as HTMLElement;
        const videoId = el.dataset.youtubeId;
        const width = el.dataset.width || '640';
        const height = el.dataset.height || '480';
        if (videoId) {
          const iframe = document.createElement('iframe');
          iframe.width = width;
          iframe.height = height;
          iframe.src = `https://www.youtube.com/embed/${videoId}`;
          iframe.setAttribute('allowfullscreen', 'allowfullscreen');
          iframe.setAttribute('frameborder', '0');
          el.replaceWith(iframe);
        }
      });
    }
    // ★ SCOPED TO ref.current, NOT `document` (2026-08-13, audit O6 item 1).
    // `id="articleBody"` is not unique — every post body and every comment
    // body on the page renders one — so a `document`-wide query here let one
    // comment's mount effect reach into the MAIN POST's DOM (and vice versa).
    const sub = ref.current?.querySelectorAll('sub');
    sub?.forEach((e) => {
      e.classList.add('leading-[22px]');
    });
    const threeSpeak = ref.current?.querySelectorAll('.threeSpeakWrapper');
    threeSpeak?.forEach((link) => {
      link.classList.add('videoWrapper');
    });
    // Note: Previously removed margins from paragraphs when !mainPost (preview mode)
    // This caused issue #759 where line breaks/spacing weren't visible in preview
    // Now paragraphs keep their default prose styling in both preview and published view
    if (communityDescription) {
      // Same scoping fix as above: was `document`-wide.
      const elementsWithVideoWrapper = ref.current?.querySelectorAll('.videoWrapper');
      elementsWithVideoWrapper?.forEach((element) => {
        element.classList.remove('videoWrapper');
      });
      const code_block = ref.current?.querySelectorAll('code');
      code_block?.forEach((c) => (c.className = 'whitespace-normal'));
      const links = ref.current?.querySelectorAll('a');
      links?.forEach((l) => (l.className = ' text-destructive break-words'));
      const iframes = ref.current?.querySelectorAll('iframe');
      iframes?.forEach((n) => {
        const srcText = document.createTextNode(n.src);
        n.replaceWith(srcText);
      });
      const facades = ref.current?.querySelectorAll('.youtube-facade');
      facades?.forEach((n) => {
        const videoId = (n as HTMLElement).dataset.youtubeId;
        const srcText = document.createTextNode(`https://www.youtube.com/watch?v=${videoId}`);
        n.replaceWith(srcText);
      });
    }

    const rootEl = ref.current;
    const pluginCleanups: (() => void)[] = [];
    if (rootEl) {
      hiveRenderer.getPlugins().forEach((plugin) => {
        const cleanup = plugin.onMount?.(rootEl);
        if (cleanup) pluginCleanups.push(cleanup);
      });
    }

    return () => {
      pluginCleanups.forEach((cleanup) => cleanup());
      if (previewMode) {
        youtubeFacades?.forEach((facade) => {
          facade.removeEventListener('click', handleYoutubeFacadeClick);
        });
      }
    };
  }, [body, hiveRenderer, previewMode]);

  const htmlBody = useMemo(() => {
    if (body) {
      const postContext = author || permlink ? { author, permlink } : undefined;
      const rendered = hiveRenderer.render(body, postContext);
      // Only the standalone post page (mainPost) also renders its own page-level
      // h1 — comments, previews and community descriptions do not, so they are
      // left with their original heading levels.
      return mainPost ? demoteHeadings(rendered) : rendered;
    }
  }, [hiveRenderer, body, author, permlink, mainPost]);

  return !htmlBody ? (
    <Loading loading={false} />
  ) : (
    <>
      <div className="flex h-fit w-full">
        <div
          id="articleBody"
          ref={ref}
          className={cn('prose w-full', className)}
          data-testid={dataTestid}
          onClick={handleBodyClick}
          dangerouslySetInnerHTML={{
            __html: htmlBody
          }}
        />
      </div>
      <LeavePageDialog link={link} open={open} setOpen={setOpen} />
      {mainPost ? <ScrollToElement rendererRef={ref} /> : null}
    </>
  );
};

export default memo(RendererContainer);
