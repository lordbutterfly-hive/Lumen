import { LumenLoader, Skeleton } from '@hive/ui';

/** See the note in `(main-and-community)/loading.tsx` for why the nav columns keep
 *  their bars while the card grid does not. */
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

export default function Loading() {
  return (
    <div className="container mx-auto max-w-screen-2xl flex-grow px-4 pb-2">
      <div className="grid grid-cols-12 md:gap-4">
        <div className="hidden md:col-span-3 md:flex xl:col-span-2">
          <SidebarSkeleton />
        </div>
        <div className="col-span-12 md:col-span-9 xl:col-span-8">
          <div className="col-span-12 mb-5 flex flex-col md:col-span-10 lg:col-span-8">
            <div className="mt-4 flex items-center justify-between">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-5 w-36" />
            </div>
            <div className="mt-4 flex w-full items-center justify-between gap-4">
              <Skeleton className="h-10 w-full max-w-md rounded-full" />
              <Skeleton className="h-10 w-32" />
            </div>
            <Skeleton className="my-4 h-px w-full" />
            <LumenLoader size="lg" />
          </div>
        </div>
        <div className="hidden xl:col-span-2 xl:flex">
          <SidebarSkeleton />
        </div>
      </div>
    </div>
  );
}
