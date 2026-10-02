import Link from '@/components/navigation/ContextLink';
import { requireAdminContext } from '@/lib/auth';
import { adminPanel } from '../_components/AdminReadUi';
const sections = [
  { title: 'Inventario y catálogo', links: [
    ['Existencias y disponibilidad', '/app/inventory'], ['Crear o modificar productos', '/app/inventory/configure'], ['Productos físicos', '/app/inventory/products'], ['Recetas y producción', '/app/inventory/recipes'], ['Recepciones y operaciones', '/app/inventory/operations'], ['Conteos', '/app/inventory/counts'], ['Ajustes', '/app/inventory/adjustments'], ['Alertas', '/app/inventory/alerts'], ['Incidentes', '/app/inventory/incidents'], ['Reportes y kardex', '/app/inventory/reports'],
  ] },
  { title: 'Clientes y ventas', links: [
    ['Crear, editar y consultar clientes', '/app/admin/configuracion/clientes'], ['Órdenes', '/app/admin/ordenes'], ['Presupuestos de eventos', '/app/events'], ['Jugadas comerciales', '/app/master/plays'], ['Metas de asesores', '/app/commissions/goals'],
  ] },
  { title: 'Cuentas y reglas financieras', links: [
    ['Cobranzas por período y vendedor', '/app/admin/finanzas/cobranzas'],
    ['Autorizar egresos, órdenes y pagos', '/app/admin/autorizaciones'],
    ['Registrar ingreso o egreso', '/app/admin/finanzas/cuentas/movimiento'],
    ['Transferir entre cuentas', '/app/admin/finanzas/cuentas/transferencia'],
    ['Registrar cierre de cuenta', '/app/admin/finanzas/cuentas/cierre'],
    ['Cuentas y movimientos', '/app/admin/finanzas/cuentas'], ['Cartera y cobros', '/app/admin/finanzas/cartera'], ['Tasa diaria e historial', '/app/admin/configuracion/tasa'], ['Administrar cuentas y reglas', '/app/admin/configuracion/cuentas'], ['Comisiones', '/app/admin/finanzas/comisiones'], ['Delivery y retornos', '/app/admin/finanzas/delivery'], ['Partners y tarifas de delivery', '/app/admin/configuracion/delivery'],
  ] },
  { title: 'Equipo y configuración', links: [
    ['Usuarios y permisos', '/app/admin/configuracion/usuarios'], ['Notificaciones', '/app/admin/notificaciones'], ['Ajustes del negocio', '/app/admin/reportes/ajustes'], ['Aprobaciones y seguimiento', '/app/admin/autorizaciones'], ['Reportes y auditoría', '/app/admin/reportes'],
  ] },
];
export default async function AdminToolsPage() {
  await requireAdminContext();
  return <div className="space-y-5"><header><h1 className="text-xl font-semibold">Herramientas</h1><p className="mt-1 text-xs text-[#9B9BA7]">Consulta u opera cada área cuando lo necesites.</p></header><div className="grid gap-3 lg:grid-cols-2">{sections.map(section => <section key={section.title} className={adminPanel}><h2 className="text-sm font-semibold">{section.title}</h2><ul className="mt-3 divide-y divide-[#292937]">{section.links.map(([label, href]) => <li key={href}><Link href={href} prefetch={false} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm text-[#D0D0DA]"><span>{label}{href.includes('adminSection=') ? <span className="ml-2 text-[10px] text-[#9B9BA7]">Panel vigente</span> : null}</span><span aria-hidden="true">→</span></Link></li>)}</ul></section>)}</div></div>;
}
