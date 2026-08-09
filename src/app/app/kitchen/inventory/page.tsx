import Link from 'next/link';

const operations = [
  {
    href: '/app/kitchen/inventory/receipts',
    step: '1',
    title: 'Registrar mercancía recibida',
    detail: 'Cuenta lo que llegó realmente. Si existía una expectativa de Máster, queda conciliada y cerrada con la cantidad física.',
  },
  {
    href: '/app/kitchen/inventory/production',
    step: '2',
    title: 'Preparar o terminar un lote',
    detail: 'Consume la receta canónica. Los prefritos solo aparecen disponibles al terminar el enfriamiento y declarar el rendimiento real.',
  },
  {
    href: '/app/kitchen/inventory/counts',
    step: '3',
    title: 'Hacer conteo ciego',
    detail: 'No muestra el saldo del sistema. Ajusta la existencia a lo contado y envía el reporte completo a revisión de Máster.',
  },
  {
    href: '/app/kitchen/inventory/losses',
    step: '4',
    title: 'Reportar calidad',
    detail: 'Averías, mermas y pruebas de calidad descuentan de inmediato. La nota es opcional y no se exige fotografía.',
  },
];

export default function KitchenInventoryPage() {
  return (
    <section>
      <div className="rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm leading-6 text-emerald-100">
        Este apartado no bloquea pedidos. Cada operación registra trazabilidad en el Centro de Inventario y se carga únicamente cuando abres su sección.
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        {operations.map((operation) => (
          <Link
            key={operation.href}
            href={operation.href}
            prefetch={false}
            className="rounded-2xl border border-[#292938] bg-[#111117] p-5 hover:border-[#FEEF00]/55"
          >
            <div className="flex items-start gap-4">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#FEEF00] text-lg font-black text-black">
                {operation.step}
              </span>
              <div>
                <h2 className="text-lg font-bold">{operation.title}</h2>
                <p className="mt-2 text-sm leading-6 text-[#A6A6B2]">{operation.detail}</p>
                <div className="mt-4 text-sm font-semibold text-[#FEEF00]">Abrir operación →</div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
