import { Skeleton } from '@hive/ui';

/** Loading placeholder shown while the first proposals fetch is in flight. */
export default function ProposalCardSkeleton() {
  return (
    <div className="rounded-2xl border border-[#ebebeb] bg-white p-[20px_22px]" data-testid="proposal-card-skeleton">
      <div className="grid grid-cols-[1fr_190px] gap-[22px]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2.5">
            <Skeleton className="h-[30px] w-[30px] rounded-full" />
            <Skeleton className="h-3.5 w-40" />
          </div>
          <Skeleton className="h-6 w-3/4" />
          <div className="mt-3 flex gap-2.5">
            <Skeleton className="h-5 w-16 rounded-[7px]" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-24" />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-[#f1f3f5] pt-3.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-24 rounded-[10px]" />
      </div>
    </div>
  );
}
