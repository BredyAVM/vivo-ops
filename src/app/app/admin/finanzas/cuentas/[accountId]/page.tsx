import Link from 'next/link';
import { notFound } from 'next/navigation';
import AccountDetail from '../_components/AccountDetail';
import { requireAdminContext } from '@/lib/auth';
import {
  loadAdminFinanceAccountDetail,
  type AdminFinanceAccountsRpcClient,
} from '@/lib/admin-finance/accounts-data';
import {
  normalizeAdminFinanceAccountSection,
  normalizeAdminFinanceDate,
  normalizeAdminFinanceDetailStatus,
} from '@/lib/admin-finance/accounts-model';
import { addDateKeyDays, getCaracasDateKey } from '@/lib/admin-finance/period';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function pageValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.trunc(parsed), 251) : 1;
}

export default async function AdminFinanceAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams?: SearchParams;
}) {
  const { accountId: rawAccountId } = await params;
  const rawSearchParams: Record<string, string | string[] | undefined> =
    (await searchParams) ?? {};
  const accountId = Number(rawAccountId);
  if (!Number.isSafeInteger(accountId) || accountId <= 0) notFound();

  const asOf = new Date();
  const todayKey = getCaracasDateKey(asOf);
  const section = normalizeAdminFinanceAccountSection(firstParam(rawSearchParams.vista));
  const status = normalizeAdminFinanceDetailStatus(
    section,
    firstParam(rawSearchParams.estado)
  );
  const requestedTo = normalizeAdminFinanceDate(firstParam(rawSearchParams.hasta), todayKey);
  const toDate = requestedTo > todayKey ? todayKey : requestedTo;
  const defaultFromCandidate =
    section === 'reconciliation' ? '2020-01-01' : addDateKeyDays(toDate, -30);
  const defaultFrom = defaultFromCandidate <= toDate ? defaultFromCandidate : toDate;
  const requestedFrom = normalizeAdminFinanceDate(firstParam(rawSearchParams.desde), defaultFrom);
  const fromDate = requestedFrom <= toDate ? requestedFrom : defaultFrom;
  const page = pageValue(firstParam(rawSearchParams.page));
  const ctx = await requireAdminContext();
  const detail = await loadAdminFinanceAccountDetail({
    supabase: ctx.supabase as unknown as AdminFinanceAccountsRpcClient,
    accountId,
    section,
    fromDate,
    toDate,
    status,
    page,
    asOf,
  });

  if (detail.status === 'error') {
    return (
      <section className="rounded-2xl border border-red-400/20 bg-red-400/5 p-5">
        <h1 className="text-lg font-semibold text-white">Detalle no disponible</h1>
        <p className="mt-1 text-sm text-red-100/75">{detail.message}</p>
        <Link
          href="/app/admin/finanzas/cuentas"
          prefetch={false}
          className="mt-4 inline-flex min-h-10 items-center rounded-xl border border-red-200/25 px-3 text-xs font-semibold text-red-100"
        >
          Volver a cuentas
        </Link>
      </section>
    );
  }

  if (detail.data === null) notFound();

  return <AccountDetail detail={detail.data} basePath="/app/admin/finanzas/cuentas" />;
}
