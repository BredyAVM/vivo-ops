export default function Loading() {
  return <section aria-busy="true" aria-label="Cargando comisiones" className="space-y-4">
    <p className="text-sm text-[#A3A3AE]">Cargando comisiones…</p>
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[0, 1, 2, 3].map(id => <div key={id} className="h-28 animate-pulse rounded-2xl bg-[#191920]" />)}</div>
  </section>;
}
