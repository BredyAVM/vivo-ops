import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { legacyAdminHref } from '@/lib/admin-finance/legacy-navigation';
import { adminPanel } from '../_components/AdminReadUi';
const sections = [
  { title: 'Inventario y catálogo', links: [
    ['Existencias y disponibilidad', '/app/inventory'], ['Crear o modificar productos', '/app/inventory/configure'], ['Productos físicos', '/app/inventory/products'], ['Recetas y producción', '/app/inventory/recipes'], ['Recepciones y operaciones', '/app/inventory/operations'], ['Conteos', '/app/inventory/counts'], ['Ajustes', '/app/inventory/adjustments'], ['Alertas', '/app/inventory/alerts'], ['Incidentes', '/app/inventory/incidents'], ['Reportes y kardex', '/app/inventory/reports'],
  ] },
  { title: 'Clientes y ventas', links: [
    ['Crear, editar y consultar clientes', legacyAdminHref('clients')], ['Órdenes', '/app/master/ops'], ['Presupuestos de eventos', '/app/events'], ['Jugadas comerciales', '/app/master/plays'], ['Metas de asesores', '/app/commissions/goals'],
  ] },
  { title: 'Cuentas y reglas financieras', links: [
    ['Registrar ingreso o egreso', '/app/admin/finanzas/cuentas/movimiento'],
    ['Cuentas y movimientos', '/app/admin/finanzas/cuentas'], ['Cartera y cobros', '/app/admin/finanzas/cartera'], ['Tasa diaria e historial', legacyAdminHref('exchange_rate')], ['Administrar cuentas y reglas', legacyAdminHref('accounts')], ['Comisiones', '/app/admin/finanzas/comisiones'], ['Delivery y retornos', '/app/admin/finanzas/delivery'], ['Partners y tarifas de delivery', legacyAdminHref('deliveries')],
  ] },
  { title: 'Equipo y configuración', links: [
    ['Usuarios y permisos', legacyAdminHref('users')], ['Notificaciones', legacyAdminHref('notifications')], ['Ajustes del negocio', legacyAdminHref('adjustments')], ['Pendientes administrativos', '/app/admin/tareas'], ['Reportes y auditoría', '/app/admin/reportes'],
  ] },
];
export default async function AdminToolsPage() {
  await requireAdminContext();
  return <div className="space-y-5"><header><h1 className="text-xl font-semibold">Herramientas</h1><p className="mt-1 text-xs text-[#9B9BA7]">Acceso a las operaciones existentes, sin cambiar sus permisos.</p></header><div className="grid gap-3 lg:grid-cols-2">{sections.map(section => <section key={section.title} className={adminPanel}><h2 className="text-sm font-semibold">{section.title}</h2><ul className="mt-3 divide-y divide-[#292937]">{section.links.map(([label, href]) => <li key={href}><Link href={href} prefetch={false} className="flex min-h-11 items-center justify-between gap-3 py-2 text-sm text-[#D0D0DA]"><span>{label}{href.includes('adminSection=') ? <span className="ml-2 text-[10px] text-[#9B9BA7]">Panel vigente</span> : null}</span><span aria-hidden="true">→</span></Link></li>)}</ul></section>)}</div><p className="text-xs text-[#9B9BA7]">Los accesos marcados «Panel vigente» abren su sección actual. Están integrados, pero su interfaz todavía no se ha trasladado a Administración V2.</p></div>;
}
