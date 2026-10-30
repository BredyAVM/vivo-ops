export default function AdminOrdersLoading() {
  return <section role="status" aria-label="Cargando órdenes" className="space-y-3">
    <h1 className="text-base font-semibold">Órdenes</h1>
    <p className="text-xs text-[#9B9BA7]">Consultando el día seleccionado…</p>
    <div aria-hidden="true" className="h-28 animate-pulse rounded-xl border border-[#292937] bg-[#111117]" />
  </section>;
}
