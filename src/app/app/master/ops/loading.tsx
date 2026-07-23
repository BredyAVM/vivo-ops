export default function MasterOpsLoading() {
  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="border-b border-[#242433] bg-[#0B0B0D]">
        <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-3 px-3 py-3 sm:px-5">
          <div className="h-5 w-28 animate-pulse rounded bg-[#242433]" />
          <div className="h-10 w-36 animate-pulse rounded-2xl bg-[#16161E]" />
          <div className="h-10 w-24 animate-pulse rounded-2xl bg-[#16161E]" />
        </div>
      </div>

      <main className="mx-auto max-w-[1400px] px-3 py-4 sm:px-5">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, index) => (
            <div
              key={index}
              className="h-32 animate-pulse rounded-2xl border border-[#242433] bg-[#121218]"
            />
          ))}
        </div>

        <div className="mt-4 h-14 animate-pulse rounded-2xl border border-[#242433] bg-[#121218]" />

        <div className="mt-4 space-y-2 lg:hidden">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-40 animate-pulse rounded-2xl border border-[#242433] bg-[#121218]"
            />
          ))}
        </div>

        <div className="mt-4 hidden overflow-hidden rounded-2xl border border-[#242433] bg-[#121218] lg:block">
          <div className="h-10 animate-pulse border-b border-[#242433] bg-[#0F0F14]" />
          {Array.from({ length: 6 }, (_, index) => (
            <div
              key={index}
              className="h-16 animate-pulse border-b border-[#242433] bg-[#121218]"
            />
          ))}
        </div>
      </main>
    </div>
  );
}
