import Link from 'next/link';
import { adminMovementHref } from '@/lib/admin-finance/movement-navigation';

export default function AccountOperationLinks({ accountId }: { accountId?: number }) {
  return <nav aria-label="Operaciones de cuenta" className="flex flex-wrap gap-2">
    {([['inflow', '+ Ingreso'], ['outflow', '− Egreso']] as const).map(([direction, label]) => (
      <Link key={direction} href={adminMovementHref(direction, accountId)} prefetch={false}
        className="inline-flex min-h-11 items-center rounded-lg border border-[#FEEF00]/50 px-4 text-sm font-semibold text-[#FEEF00] hover:bg-[#FEEF00]/10">
        {label}
      </Link>
    ))}
    <Link href={`/app/admin/finanzas/cuentas/transferencia${accountId ? `?cuenta=${accountId}` : ''}`} prefetch={false}
      className="inline-flex min-h-11 items-center rounded-lg border border-[#343442] px-4 text-sm font-semibold text-white hover:border-[#FEEF00]/50">Transferir</Link>
  </nav>;
}
