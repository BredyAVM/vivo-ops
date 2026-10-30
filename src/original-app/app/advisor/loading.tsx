function LoadingBlock({
  className,
}: {
  className: string;
}) {
  return <div className={`animate-pulse rounded-[18px] bg-[#141924] ${className}`} />;
}

export default function AdvisorLoading() {
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-[24px] border border-[#232632] bg-[#12151d]">
        <div className="h-1 w-full animate-pulse bg-[#F0D000]" />
        <div className="space-y-3 px-4 py-4">
          <LoadingBlock className="h-3 w-24" />
          <LoadingBlock className="h-6 w-40" />
          <LoadingBlock className="h-4 w-full" />
          <LoadingBlock className="h-4 w-3/4" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <LoadingBlock className="h-28" />
        <LoadingBlock className="h-28" />
      </div>

      <div className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-4">
        <div className="space-y-3">
          <LoadingBlock className="h-4 w-28" />
          <LoadingBlock className="h-20" />
          <LoadingBlock className="h-20" />
          <LoadingBlock className="h-20" />
        </div>
      </div>
    </div>
  );
}
