export default function MovementLoading() {
  return <section aria-busy="true" className="space-y-3 text-xs text-[#9696A4]">
    <p role="status">Consultando el movimiento…</p>
    <div className="h-16 animate-pulse rounded-xl border border-[#292937] bg-[#111117]" />
  </section>;
}
