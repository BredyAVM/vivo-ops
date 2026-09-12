import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminFinanceAccountsOverview, type AdminFinanceAccountsRpcClient } from '@/lib/admin-finance/accounts-data';
import { resolveAdminMovementContext } from '@/lib/admin-finance/movement-navigation';
import { getCaracasDateKey } from '@/lib/admin-finance/period';
import ClosureForm from './ClosureForm';
export default async function AdminClosurePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  const overview = await loadAdminFinanceAccountsOverview({ supabase: ctx.supabase as unknown as AdminFinanceAccountsRpcClient });
  if (overview.status === 'error') return <section role="alert"><h1 className="text-xl font-semibold">Cierre no disponible</h1><p>No se pudieron verificar las cuentas.</p><Link href="/app/admin/finanzas/cuentas">Volver a cuentas</Link></section>;
  const context = resolveAdminMovementContext(await searchParams, overview.data.accounts);
  if (context.invalidAccount) return <section role="alert"><h1 className="text-xl font-semibold">Cuenta no disponible</h1><Link href="/app/admin/finanzas/cuentas">Seleccionar una cuenta activa</Link></section>;
  const now = new Date();
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Caracas', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  return <div className="space-y-4"><header><Link href={`/app/admin/finanzas/cuentas${context.accountId ? `/${context.accountId}` : ''}`} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-[#9B9BA7]">← Volver a cuentas</Link><h1 className="text-xl font-semibold">Cierre de cuenta</h1><p className="mt-1 text-xs text-[#9B9BA7]">Registra el saldo contado. No genera un ingreso, egreso ni traspaso.</p></header>
    <ClosureForm accounts={overview.data.accounts.filter(a => a.isActive).map(a => ({ id: a.id, name: a.name, currencyCode: a.currencyCode, intraday: a.accountKind === 'cash' || a.accountKind === 'pos' || a.closureKind === 'cash' || a.closureKind === 'pos' }))}
      initialAccountId={context.accountId} activeRate={overview.data.activeRateBsPerUsd} today={getCaracasDateKey(now)} time={time} />
  </div>;
}
