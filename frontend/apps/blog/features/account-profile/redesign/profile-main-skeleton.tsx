import { Skeleton } from '@ui/components/skeletons/skeleton';

/** Loading state shaped like the redesigned profile (cover/avatar/identity/stats), not the legacy dark banner. */
export default function ProfileMainSkeleton() {
  return (
    <div role="status" aria-label="Loading profile" data-testid="profile-main-skeleton">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-[210px] w-full rounded-[22px]" />
      <div className="mt-[58px] pl-1.5">
        <Skeleton className="h-8 w-52" />
        <Skeleton className="mt-3 h-4 w-32" />
        <Skeleton className="mt-3 h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="mt-5 h-[76px] w-full rounded-2xl" />
      <div className="mt-8 flex gap-6 border-b border-[#ebebeb] pb-3">
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-24" />
      </div>
      <div className="mt-6 flex flex-col gap-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
