import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminFinanceAccountsOverview, type AdminFinanceAccountsRpcClient } from '@/lib/admin-finance/accounts-data';
import { resolveAdminMovementContext } from '@/lib/admin-finance/movement-navigation';
import { getCaracasDateKey } from '@/lib/admin-finance/period';
import TransferForm from './TransferForm';

export default async function AdminTransferPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAdminContext();
  const params = await searchParams;
  const overview = await loadAdminFinanceAccountsOverview({ supabase: ctx.supabase as unknown as AdminFinanceAccountsRpcClient });
  if (overview.status === 'error') return <section role="alert" className="space-y-3"><h1 className="text-xl font-semibold">Transferencias no disponibles</h1><p>No se pudieron verificar las cuentas. No se registró ninguna operación.</p><Link href="/app/admin/finanzas/cuentas">Volver a cuentas</Link></section>;
  const context = resolveAdminMovementContext(params, overview.data.accounts);
  if (context.invalidAccount) return <section role="alert" className="space-y-3"><h1 className="text-xl font-semibold">Cuenta de origen no disponible</h1><Link href="/app/admin/finanzas/cuentas">Seleccionar una cuenta activa</Link></section>;
  return <div className="space-y-4">
    <header><Link href={`/app/admin/finanzas/cuentas${context.accountId ? `/${context.accountId}` : ''}`} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-[#9B9BA7]">← Volver a cuentas</Link><h1 className="text-xl font-semibold">Transferencia entre cuentas</h1></header>
    <TransferForm key={context.accountId ?? 'all'} accounts={overview.data.accounts.filter(account => account.isActive).map(account => ({ id: account.id, name: account.name, currencyCode: account.currencyCode }))} initialAccountId={context.accountId} activeRate={overview.data.activeRateBsPerUsd} today={getCaracasDateKey(new Date())} />
  </div>;
}
