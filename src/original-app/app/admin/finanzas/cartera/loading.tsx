export default function AdminFinanceReceivablesLoading() {
  return (
    <div className="space-y-4">
      <div className="h-12 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-44 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
      <div className="h-80 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
      <span className="sr-only">Cargando cartera.</span>
    </div>
  );
}
