import Link from 'next/link';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminFinanceAccountsOverview, type AdminFinanceAccountsRpcClient } from '@/lib/admin-finance/accounts-data';
import { resolveAdminMovementContext } from '@/lib/admin-finance/movement-navigation';
import { getCaracasDateKey } from '@/lib/admin-finance/period';
import MasterOpsMoneyMovementForm from '@/app/app/master/ops/finance/MasterOpsMoneyMovementForm';
import { createAdminMoneyMovementAction } from './actions';

export default async function AdminMoneyMovementPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireAdminContext();
  const params = await searchParams;
  const overview = await loadAdminFinanceAccountsOverview({ supabase: ctx.supabase as unknown as AdminFinanceAccountsRpcClient });
  if (overview.status === 'error') {
    return <section role="alert" className="space-y-3 text-sm text-orange-100">
      <h1 className="text-xl font-semibold">Registro no disponible</h1>
      <p>No se pudieron verificar las cuentas. No se ha registrado ningún movimiento.</p>
      <Link href="/app/admin/finanzas/cuentas" prefetch={false} className="inline-flex min-h-11 items-center underline">Volver a cuentas</Link>
    </section>;
  }
  const data = overview.data;
  const context = resolveAdminMovementContext(params, data.accounts);
  if (context.invalidAccount) {
    return <section role="alert" className="space-y-3 text-sm text-orange-100">
      <h1 className="text-xl font-semibold">Cuenta no disponible</h1>
      <p>La cuenta del enlace no existe, está inactiva o no está disponible para esta sesión.</p>
      <Link href="/app/admin/finanzas/cuentas" prefetch={false} className="inline-flex min-h-11 items-center underline">Seleccionar otra cuenta</Link>
    </section>;
  }
  const backHref = `/app/admin/finanzas/cuentas${context.accountId ? `/${context.accountId}` : ''}`;
  return <div className="space-y-4">
    <header>
      <Link href={backHref} prefetch={false} className="inline-flex min-h-11 items-center text-sm text-[#9B9BA7]">← Volver a cuentas</Link>
      <h1 className="text-xl font-semibold">Ingreso / Egreso</h1>
      <p className="mt-1 text-xs text-[#9B9BA7]">Caja chica y movimientos operativos. Los cobros de clientes se registran en su orden.</p>
    </header>
    <section className="rounded-xl border border-[#292937] bg-[#121218] p-4">
      <MasterOpsMoneyMovementForm
        key={`${context.accountId ?? 'all'}:${context.direction}`}
        accounts={data.accounts.filter(account => account.isActive).map(account => ({ id: account.id, name: account.name, currencyCode: account.currencyCode }))}
        activeRate={data.activeRateBsPerUsd}
        defaultDate={getCaracasDateKey(new Date())}
        isAdmin
        initialAccountId={context.accountId}
        initialDirection={context.direction}
        submitAction={createAdminMoneyMovementAction}
        showAdminHistory
      />
    </section>
  </div>;
}
