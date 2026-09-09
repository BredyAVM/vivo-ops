export default function AdminLoading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="Cargando Administración"
    >
      <div className="flex items-end justify-between gap-4">
        <div className="h-8 w-44 animate-pulse rounded-lg bg-[#1A1A24] motion-reduce:animate-none" />
        <div className="h-10 w-28 animate-pulse rounded-xl bg-[#1A1A24] motion-reduce:animate-none" />
      </div>
      <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            key={index}
            className="h-32 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none"
          />
        ))}
      </div>
      <div className="grid gap-3 xl:grid-cols-[minmax(0,2fr)_minmax(280px,0.8fr)]">
        <div className="h-72 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none" />
        <div className="h-72 animate-pulse rounded-2xl border border-[#242433] bg-[#111117] motion-reduce:animate-none" />
      </div>
      <span className="sr-only">Cargando el centro administrativo.</span>
    </div>
  );
}
