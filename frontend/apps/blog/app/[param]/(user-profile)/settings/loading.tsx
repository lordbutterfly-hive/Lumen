import { Skeleton } from '@hive/ui';
import { SETTINGS_CARD } from '@/blog/features/account-settings/lib/card';
// Server-side t(): no 'use client' here -- see `[permlink]/loading.tsx` for
// why `i18n/server`, not `i18n/client`, is correct in this file.
// Aliased deliberately: this is the SERVER helper, an async function, NOT a
// React hook. Imported under its own name it trips `react-hooks/rules-of-hooks`
// ('cannot be called in an async function') purely because of the `use` prefix.
import { useTranslation as getServerTranslation } from '@/blog/i18n/server';

/**
 * ★ 2026-08-17 — `/@username/settings` had NO loading.tsx of its own. The
 * parent `[param]/(user-profile)/loading.tsx` does NOT cover it: per Next's
 * own rule, a `loading.tsx` is a boundary for the segment it is defined in
 * only, not for a nested segment below it (see that file, and this repo's
 * `next.config.js` "RETIRED ROUTES" comment for the same rule biting a
 * `redirect()`). `settings/` is its own segment with its own `layout.tsx`
 * (mounts `ProfileSubpageShell` -> the left rail + the "Settings" masthead),
 * and with no `loading.tsx` of its own that whole segment -- shell included --
 * had no Suspense boundary, so a slow navigation here showed nothing at all
 * until everything was ready. This is the first boundary in that segment, so
 * it has to stand in for the shell too, not just the settings content below
 * it -- same reasoning as `communities/loading.tsx`, which duplicates its
 * own `SidebarSkeleton` for the identical reason.
 *
 * Card shapes below mirror `content.tsx`'s own `OwnerGateSkeleton` (same
 * `SETTINGS_CARD` shell, same idea) plus the two cards it doesn't cover
 * (`Preferences`, `Blocked accounts`) -- so a reader who lands here mid-fetch
 * sees the same stack of cards `SettingsContent` actually renders, just empty.
 */
function SidebarSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Skeleton className="h-6 w-32" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-full" />
    </div>
  );
}

/** Stand-in for `ProfileSubpageShell`'s `PageMasthead` call: eyebrow
 *  `@username`, title "Settings", and the "Back to profile" link on the meta
 *  row. Same header shell classes as `page-masthead.tsx`. */
function MastheadSkeleton() {
  return (
    <header className="relative mb-7 overflow-hidden rounded-panel border border-line-warn-3 border-l-[3px] border-l-line-brand-10 bg-[radial-gradient(125%_130%_at_0%_0%,rgb(var(--masthead-1))_0%,rgb(var(--masthead-2))_30%,rgb(var(--masthead-3))_58%,rgb(var(--masthead-4))_85%)] px-7 pb-5 pt-7">
      <Skeleton className="mb-1.5 h-[18px] w-24" />
      <Skeleton className="h-[38px] w-40" />
      <div className="mt-3.5">
        <Skeleton className="h-5 w-36" />
      </div>
    </header>
  );
}

/** Two fields per row, same `md:grid-cols-2` the real form cards use. */
const FieldGridSkeleton = ({ fields }: { fields: number }) => (
  <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
    {Array.from({ length: fields }).map((_, i) => (
      <div key={i}>
        <Skeleton className="mb-1.5 h-[12px] w-24" />
        <Skeleton className="h-10 w-full" />
      </div>
    ))}
  </div>
);

export default async function Loading() {
  const { t } = await getServerTranslation('common_blog');
  return (
    <div className="relative mx-auto grid max-w-[1720px] grid-cols-1 gap-11 px-6 pb-20 pt-[26px] md:grid-cols-[200px_minmax(0,1fr)] md:px-11">
      {/* Visually hidden: Skeleton/masthead below are decorative (aria-hidden),
          so this is the only thing a screen reader announces for this route,
          same job `label` does on every `LumenLoader` call in this codebase. */}
      <span role="status" aria-live="polite" className="sr-only">
        {t('global.loading_settings')}
      </span>
      <div
        className="pointer-events-none absolute bottom-20 left-[244px] top-[26px] hidden w-px bg-surface-26 md:block"
        aria-hidden
      />

      <aside className="sticky top-24 hidden h-fit bg-background-secondary md:block">
        <SidebarSkeleton />
      </aside>

      <main className="min-w-0" aria-hidden="true">
        <MastheadSkeleton />
        <div className="flex flex-col gap-5">
          {/* Public profile settings -- 8 fields (profile/cover image, name,
              about, location, website, blacklist + muted descriptions) plus
              the Update button, matching `form.tsx`'s non-lite card. */}
          <section className={SETTINGS_CARD}>
            <Skeleton className="h-[19px] w-64" />
            <Skeleton className="mt-2 h-[13px] w-[28rem] max-w-full" />
            <FieldGridSkeleton fields={8} />
            <Skeleton className="mt-6 h-11 w-[176px] rounded-card" />
          </section>

          {/* Preferences -- NSFW + the three reward/beneficiary selects. */}
          <section className={SETTINGS_CARD}>
            <Skeleton className="h-[19px] w-40" />
            <Skeleton className="mt-2 h-[13px] w-[24rem] max-w-full" />
            <FieldGridSkeleton fields={4} />
          </section>

          {/* Legal -- Privacy / Terms / Help links. */}
          <section className={SETTINGS_CARD}>
            <Skeleton className="h-[19px] w-24" />
            <div className="mt-3 flex flex-wrap gap-5">
              <Skeleton className="h-[22px] w-28" />
              <Skeleton className="h-[22px] w-32" />
              <Skeleton className="h-[22px] w-20" />
            </div>
          </section>

          {/* Blocked accounts -- same two-row shape `blocked-list.tsx` itself
              shows for its OWN `isLoading` state (`settings-blocked-accounts-skeleton`),
              reused here so the two don't drift apart. */}
          <section className={SETTINGS_CARD}>
            <Skeleton className="h-[19px] w-48" />
            <Skeleton className="mt-2 h-[13px] w-[26rem] max-w-full" />
            <div className="mt-4 space-y-2">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
