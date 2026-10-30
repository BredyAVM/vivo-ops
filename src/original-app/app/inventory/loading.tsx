export default function InventoryLoading() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Cargando inventario">
      <div className="h-8 w-72 animate-pulse rounded-lg bg-[#1A1A24]" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-24 animate-pulse rounded-2xl border border-[#242433] bg-[#111117]" />
        ))}
      </div>
      <div className="h-[420px] animate-pulse rounded-2xl border border-[#242433] bg-[#111117]" />
    </div>
  );
}
