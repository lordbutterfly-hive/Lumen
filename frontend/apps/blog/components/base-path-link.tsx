// eslint-disable-next-line no-restricted-imports -- This is a wrapper component that needs direct access to next/link
import Link from 'next/link';
import { AnchorHTMLAttributes, MouseEvent, ReactNode, forwardRef } from 'react';
import { buildSafePath, isInternalPath } from '@ui/lib/sanitize-url';
import { getLogger } from '@ui/lib/logging';

const logger = getLogger('BasePathLink');

interface BasePathLinkProps
  extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'className' | 'onClick' | 'children'> {
  href: string;
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  prefetch?: boolean;
  'aria-current'?: 'page' | undefined;
  'aria-busy'?: boolean | undefined;
  onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Fired only for a click that is really going to navigate THIS tab: not a
   * blocked href, not cmd/ctrl/middle-click (which opens a new tab and leaves
   * this page exactly where it is). Callers use it to show that a slow
   * navigation has started — see left-rail.tsx.
   */
  onNavigate?: () => void;
}
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/**
 * Custom Link component that handles basePath navigation issues with catch-all routes.
 * For user profile links (starting with @) and comment links (containing #@),
 * it forces a full page reload when using basePath to ensure getServerSideProps
 * is called and the correct page type is rendered.
 *
 * Security: All hrefs are validated to prevent XSS via javascript: or other dangerous protocols.
 *
 * ★ forwardRef + `...rest` (2026-08-13, O5 a11y build map item 1 blocker). Before
 * this, the component took a fixed whitelist of named props and forwarded no ref —
 * harmless for a plain `<BasePathLink>` call, but it meant `<DropdownMenuItem
 * asChild><BasePathLink .../></DropdownMenuItem>` silently dropped every prop
 * Radix's `Slot` merges in (`onClick`, `role`, `tabIndex`, `id`, the roving-focus
 * `data-*` attributes) and never attached the ref Radix needs for focus
 * management — so `asChild` over this component failed with no error, just a
 * non-interactive menu row. `rest` now carries anything not explicitly named
 * (role/tabIndex/onKeyDown/etc.) straight through to the underlying `<Link>`, and
 * `onClick` is composed (caller's fires first, exactly like `next/link`'s own
 * convention) rather than either handler silently overwriting the other.
 */
const BasePathLink = forwardRef<HTMLAnchorElement, BasePathLinkProps>(
  (
    {
      href,
      children,
      className,
      'data-testid': dataTestId,
      prefetch = false,
      'aria-current': ariaCurrent,
      'aria-busy': ariaBusy,
      onClick,
      onNavigate,
      ...rest
    },
    ref
  ) => {
    const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
      // Compose: whoever passed onClick (e.g. Radix's own item-selection
      // handler when this is used with `asChild`) runs first, same order
      // `next/link` itself uses for a caller-supplied onClick.
      onClick?.(e);

      // ★ RESPECT A CANCELLED CLICK (2026-08-13). Everything below assumes this
      // navigation is going to happen. It might not: the offline guard installs a
      // capture-phase handler that calls `preventDefault()` on link clicks while
      // the browser is offline, and `onClick` above can cancel too. Without this
      // check, two things went wrong — `onNavigate?.()` fired for a navigation that
      // never started, so the left rail's pending spinner span forever AND its
      // truthy `navigatingTo` suppressed the "you are here" highlight on every row
      // (the exact bug that pending state was added to fix); and the
      // `window.location.href` assignment below is an imperative navigation that
      // `preventDefault()` cannot stop at all, so a basePath deployment would still
      // have landed on the browser's offline error page — the one thing the guard
      // exists to prevent. `next/link` performs this same check for the same reason.
      if (e.defaultPrevented) return;

      // Security: Validate that href is an internal path before navigation
      if (!isInternalPath(href)) {
        logger.warn({ href }, 'BasePathLink blocked potentially dangerous href');
        e.preventDefault();
        return;
      }

      const opensElsewhere = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
      if (!opensElsewhere) onNavigate?.();

      // Force full page reload for certain link types when using basePath
      // This ensures getServerSideProps runs and the correct page component is rendered
      // For root deployments (no basePath), use normal Next.js navigation
      const needsReload = href.startsWith('/@') || href.includes('/#@');

      // Also force reload for static pages to avoid intermittent navigation failures
      const isStaticPage = href === '/privacy.html' || href === '/tos.html';

      if ((needsReload || isStaticPage) && basePath) {
        e.preventDefault();
        // Security: Build path safely to prevent XSS
        const fullPath = buildSafePath(basePath, href);
        if (!fullPath) {
          logger.warn({ href, basePath }, 'BasePathLink blocked unsafe path construction');
          return;
        }
        logger.debug({ href, basePath, fullPath }, 'BasePathLink forcing reload');
        window.location.href = fullPath;
      }
    };

    return (
      <Link
        ref={ref}
        href={href}
        className={className}
        data-testid={dataTestId}
        prefetch={prefetch}
        aria-current={ariaCurrent}
        aria-busy={ariaBusy}
        onClick={handleClick}
        {...rest}
      >
        {children}
      </Link>
    );
  }
);
BasePathLink.displayName = 'BasePathLink';

export default BasePathLink;
