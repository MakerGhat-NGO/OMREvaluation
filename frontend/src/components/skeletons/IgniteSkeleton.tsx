// The IGNITE data screen (admins only) while its numbers load: the publish card, then one district
// card with a few blocks. The page title and the sentence under it are already on screen.
import { Skeleton, SkeletonScreen } from '../ui';

const BLOCKS = ['w-32', 'w-24', 'w-36', 'w-28'];

export default function IgniteSkeleton() {
  return (
    <SkeletonScreen label="Loading the numbers…" className="flex flex-col gap-5">
      <div className="card flex flex-col gap-3.5">
        <div className="flex h-7 items-center">
          <Skeleton className="h-[18px] w-56 rounded-full" />
        </div>
        <div className="flex h-6 items-center">
          <Skeleton className="h-4 w-4/5 rounded-full sm:w-96" />
        </div>
        <Skeleton className="h-14 w-full rounded-[14px]" />
        <Skeleton className="h-[52px] w-[250px] max-w-full rounded-full" />
      </div>
      <div className="card flex flex-col gap-4">
        <div className="flex flex-col">
          <div className="flex h-7 items-center">
            <Skeleton className="h-[18px] w-32 rounded-full" />
          </div>
          <div className="flex h-[22px] items-center">
            <Skeleton className="h-3.5 w-3/4 rounded-full sm:w-80" />
          </div>
        </div>
        <div className="flex flex-col gap-2.5">
          {BLOCKS.map((name, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-2xl border border-line bg-white px-4 py-3">
              <div className="flex h-[26px] items-center">
                <Skeleton className={`h-4 rounded-full ${name}`} />
              </div>
              <div className="flex h-[22px] items-center">
                <Skeleton className="h-3.5 w-2/3 rounded-full sm:w-72" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </SkeletonScreen>
  );
}
