export default function AdminFinanceAccountsLoading() {
  return (
    <div className="space-y-4" role="status" aria-label="Cargando cuentas financieras">
      <div className="h-9 w-48 animate-pulse rounded-lg bg-[#1A1A24] motion-reduce:animate-none" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="h-20 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
        ))}
      </div>
      <div className="h-12 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
      <div className="h-80 animate-pulse rounded-xl bg-[#111117] motion-reduce:animate-none" />
      <span className="sr-only">Cargando cuentas financieras.</span>
    </div>
  );
}
