import Link from 'next/link';

const operations = [
  {
    href: '/app/kitchen/inventory/receipts',
    eyebrow: 'Llegó mercancía',
    title: 'Registrar entrada',
    detail: 'Ingresa únicamente lo recibido físicamente y concilia cualquier expectativa de Máster.',
  },
  {
    href: '/app/kitchen/inventory/production',
    eyebrow: 'Se preparó un lote',
    title: 'Registrar producción',
    detail: 'Inicia o termina una preparación usando la receta, el tiempo y el rendimiento real.',
  },
  {
    href: '/app/kitchen/inventory/losses',
    eyebrow: 'Hubo una salida de calidad',
    title: 'Reportar calidad',
    detail: 'Registra averías, mermas o cantidades consumidas en pruebas de calidad.',
  },
];

export default function KitchenInventoryPage() {
  return (
    <section>
      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm leading-6 text-emerald-100">
        Este apartado no bloquea pedidos. Cada operación deja trazabilidad en el mismo Centro de Inventario.
      </div>

      <Link
        href="/app/kitchen/inventory/counts"
        prefetch={false}
        className="mt-5 block rounded-2xl border border-[#FEEF00]/45 bg-[#FEEF00]/8 p-5 transition hover:border-[#FEEF00]"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.14em] text-[#FEEF00]">Tarea principal</div>
            <h2 className="mt-1 text-xl font-black">Hacer inventario</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-[#C4C4CE]">
              Elige por turno, diario, semanal, quincenal o mensual. Verás únicamente los productos configurados para ese inventario y nunca el saldo esperado.
            </p>
          </div>
          <span className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-xl bg-[#FEEF00] px-5 font-black text-black">
            Seleccionar tipo →
          </span>
        </div>
      </Link>

      <div className="mt-7">
        <h2 className="text-lg font-bold">Otras operaciones</h2>
        <p className="mt-1 text-sm text-[#858591]">Abre solo la tarea que necesitas registrar.</p>
      </div>
      <div className="mt-3 grid gap-4 md:grid-cols-3">
        {operations.map((operation) => (
          <Link
            key={operation.href}
            href={operation.href}
            prefetch={false}
            className="rounded-2xl border border-[#292938] bg-[#111117] p-5 hover:border-[#FEEF00]/55"
          >
            <div className="text-xs font-bold uppercase tracking-[0.12em] text-[#858591]">{operation.eyebrow}</div>
            <div>
              <h3 className="mt-2 text-lg font-bold">{operation.title}</h3>
              <p className="mt-2 text-sm leading-6 text-[#A6A6B2]">{operation.detail}</p>
              <div className="mt-4 text-sm font-semibold text-[#FEEF00]">Abrir →</div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
