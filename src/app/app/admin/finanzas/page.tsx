import { redirect } from 'next/navigation';
import AdminSectionHub from '../_components/AdminSectionHub';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminFinancesPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  // Preserve links to dated financial snapshots, including their return context.
  if (params.period !== undefined || params.asOf !== undefined || params.definition !== undefined) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
    }
    redirect(`/app/admin/finanzas/resumen?${query}`);
  }
  return <AdminSectionHub section="finance" actions={[
    { label: 'Ingreso', description: 'Registrar entrada de dinero', href: '/app/admin/finanzas/cuentas/movimiento?tipo=inflow' },
    { label: 'Egreso', description: 'Registrar salida de dinero', href: '/app/admin/finanzas/cuentas/movimiento?tipo=outflow' },
    { label: 'Cierre de caja', description: 'Cerrar caja o cuenta', href: '/app/admin/finanzas/cuentas/cierre' },
    { label: 'Transferencia', description: 'Mover dinero entre cuentas', href: '/app/admin/finanzas/cuentas/transferencia' },
  ]} />;
}
