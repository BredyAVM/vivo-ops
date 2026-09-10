import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { adminPanel } from '../_components/AdminReadUi';
export default async function AdminReportsPage() {
  await requireAdminContext();
  return <div className="space-y-5"><header><h1 className="text-xl font-semibold">Reportes y auditoría</h1><p className="mt-1 text-xs text-[#9B9BA7]">Descargas al momento de consultar; importes y calidad identificados.</p></header>
    <section className="grid gap-3 lg:grid-cols-2">{[
      { domain: 'cuentas', title: 'Estado de cuentas', description: 'Todas las cuentas, activas e inactivas. Saldo nativo, equivalencia actual, base y pendientes.', href: '/app/admin/finanzas/cuentas?estado=all' },
      { domain: 'pedidos', title: 'Pedidos por entregar', description: 'Todos los pedidos activos de la consulta: total, cubierto y pendiente en USD. No es facturación entregada.', href: '/app/admin/finanzas/pedidos' },
    ].map(report => <article key={report.domain} className={adminPanel}><h2 className="text-sm font-semibold">{report.title}</h2><p className="mt-2 text-xs text-[#B9B9C4]">{report.description}</p><div className="mt-3 flex flex-wrap gap-4 text-sm"><a href={`/app/admin/reportes/exportar?dominio=${report.domain}`} className="inline-flex min-h-11 items-center underline">Descargar CSV</a><Link href={report.href} prefetch={false} className="inline-flex min-h-11 items-center underline">Consultar detalle →</Link></div></article>)}</section>
    <section className={adminPanel}><h2 className="text-sm font-semibold">Revisar movimientos y evidencia</h2><div className="mt-2 grid gap-2 sm:grid-cols-2">{[['Cuentas y conciliaciones','/app/admin/finanzas/cuentas'],['Cartera y cobros','/app/admin/finanzas/cartera'],['Comisiones y pagos','/app/admin/finanzas/comisiones'],['Liquidaciones de delivery','/app/admin/finanzas/delivery#liquidaciones'],['Reportes de inventario','/app/inventory/reports']].map(([label, href]) => <Link key={href} href={href} prefetch={false} className="inline-flex min-h-11 items-center text-sm underline">{label} →</Link>)}</div></section>
    <p className="text-xs text-[#9B9BA7]">Los archivos exportan la selección completa descrita arriba, no los filtros de otra pantalla. El corte queda incluido en cada fila y en la descarga. Los valores no disponibles quedan vacíos; no se convierten en cero.</p>
  </div>;
}
