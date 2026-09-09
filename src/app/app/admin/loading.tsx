export default function AdminLoading() {
  return (
    <div
      className="space-y-8"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Cargando Administración"
    >
      <div className="h-[330px] animate-pulse rounded-[28px] border border-[#242433] bg-[#111117] motion-reduce:animate-none sm:h-[300px]" />
      <div>
        <div className="h-7 w-72 max-w-full animate-pulse rounded-lg bg-[#1A1A24] motion-reduce:animate-none" />
        <div className="mt-5 grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <div
              key={index}
              className="h-48 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none"
            />
          ))}
        </div>
      </div>
      <div className="grid gap-3 xl:grid-cols-2">
        <div className="h-72 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none" />
        <div className="h-72 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Cargando el centro administrativo.</span>
    </div>
  );
}
