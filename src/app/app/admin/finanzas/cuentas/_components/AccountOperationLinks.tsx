import Link from '@/components/navigation/ContextLink';
import { adminMovementHref } from '@/lib/admin-finance/movement-navigation';

export default function AccountOperationLinks({ accountId }: { accountId?: number }) {
  return <nav aria-label="Operaciones de cuenta" className="flex flex-wrap gap-2">
    <Link href={`/app/admin/finanzas/cuentas/cierre${accountId ? `?cuenta=${accountId}` : ''}`} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs font-medium text-[#C8C8D1] sm:min-h-8">Cerrar cuenta</Link>
    <Link href="/app/admin/autorizaciones?tipo=expense" prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs font-medium text-[#C8C8D1] sm:min-h-8">Autorizar egresos</Link>
    {([['inflow', '+ Ingreso'], ['outflow', '− Egreso']] as const).map(([direction, label]) => (
      <Link key={direction} href={adminMovementHref(direction, accountId)} prefetch={false}
        className="inline-flex min-h-11 items-center rounded-lg border border-[#FEEF00]/50 px-3 text-xs font-medium text-[#FEEF00] hover:bg-[#FEEF00]/10 sm:min-h-8">
        {label}
      </Link>
    ))}
    <Link href={`/app/admin/finanzas/cuentas/transferencia${accountId ? `?cuenta=${accountId}` : ''}`} prefetch={false}
      className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-3 text-xs font-medium text-[#C8C8D1] hover:border-[#FEEF00]/50 sm:min-h-8">Transferir</Link>
  </nav>;
}
