import Link from 'next/link';
import AdminQualityIndicator from '@/app/app/admin/_components/AdminQualityIndicator';
import {
  filterAdminFinanceAccounts,
  type AdminFinanceAccountSnapshot,
  type AdminFinanceAccountsFilters,
  type AdminFinanceAccountsOverview,
} from '@/lib/admin-finance/accounts-model';
import { FINANCE_WORKSTREAM_LABELS } from '@/lib/domain/finance-domain';

type AccountsOverviewProps = {
  overview: AdminFinanceAccountsOverview;
  filters: AdminFinanceAccountsFilters;
  basePath: string;
};

const amountFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const rateFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  timeZone: 'America/Caracas',
});

const dateTimeFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'America/Caracas',
});

const singularWorkstreamLabels: Record<AdminFinanceAccountSnapshot['workstream'], string> = {
  bank: 'Banco',
  pos: 'Punto',
  cash: 'Caja',
  wallet: 'Wallet',
  retention: 'Retenciones',
  fund: 'Fondo',
  other: 'Otra',
};

function normalizeBasePath(basePath: string) {
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function formatNative(value: number, currencyCode: AdminFinanceAccountSnapshot['currencyCode']) {
  return currencyCode === 'USD' ? `$${amountFormatter.format(value)}` : `Bs ${amountFormatter.format(value)}`;
}

function formatUsd(value: number) {
  return `$${amountFormatter.format(value)}`;
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const date = new Date(`${value.slice(0, 10)}T12:00:00-04:00`);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatAsOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function accountHref(
  basePath: string,
  accountId: number,
  attention: AdminFinanceAccountsFilters['attention']
) {
  const path = `${normalizeBasePath(basePath)}/${accountId}`;
  if (attention === 'pending_movements') return `${path}?estado=pending`;
  if (attention === 'open_reconciliation' || attention === 'orphaned_reconciliation') {
    return `${path}?vista=reconciliation&estado=open`;
  }
  if (attention === 'no_anchor') return `${path}?vista=configuration`;
  return path;
}

function overviewHref(
  basePath: string,
  filters: AdminFinanceAccountsFilters,
  overrides: Partial<AdminFinanceAccountsFilters>
) {
  const next = { ...filters, ...overrides };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.group !== 'all') params.set('grupo', next.group);
  if (next.currency !== 'all') params.set('moneda', next.currency);
  if (next.state !== 'active') params.set('estado', next.state);
  if (next.quality !== 'all') params.set('calidad', next.quality);
  if (next.attention !== 'all') params.set('state', next.attention);
  if (next.sort !== 'attention') params.set('orden', next.sort);
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  return query ? `${normalizeBasePath(basePath)}?${query}` : normalizeBasePath(basePath);
}

function OverviewKpi({
  label,
  value,
  detail,
  help,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  help?: string;
  tone?: 'neutral' | 'warning';
}) {
  const warning = tone === 'warning';
  return (
    <div
      className={`min-w-0 rounded-xl border px-3 py-3 sm:px-4 ${warning ? 'border-orange-300/25 bg-orange-300/[0.04]' : 'border-[#292937] bg-[#111117]'}`}
      title={help}
    >
      <p className={`text-[10px] font-bold uppercase tracking-[0.12em] ${warning ? 'text-orange-200' : 'text-[#92929E]'}`}>{label}</p>
      <p className="mt-1.5 whitespace-nowrap text-[clamp(1.05rem,4vw,1.75rem)] font-semibold leading-none tracking-[-0.035em] text-white tabular-nums">
        {value}
      </p>
      {detail ? <p className={`mt-1.5 truncate text-[11px] ${warning ? 'text-orange-100/80' : 'text-[#858592]'}`}>{detail}</p> : null}
    </div>
  );
}

function AccountIdentity({ account }: { account: AdminFinanceAccountSnapshot }) {
  const metadata = [account.institutionName, account.ownerName].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${account.isActive ? 'bg-emerald-300' : 'bg-[#666672]'}`}
          title={account.isActive ? 'Activa' : 'Inactiva'}
          aria-label={account.isActive ? 'Cuenta activa' : 'Cuenta inactiva'}
        />
        <span className="truncate font-semibold text-white">{account.name}</span>
      </div>
      {metadata ? <p className="mt-0.5 truncate text-[11px] text-[#7F7F8C]">{metadata}</p> : null}
    </div>
  );
}

function BalanceValue({ account }: { account: AdminFinanceAccountSnapshot }) {
  return (
    <div className="min-w-0">
      <p className="whitespace-nowrap font-semibold text-white tabular-nums">
        {formatNative(account.balanceNative, account.currencyCode)}
      </p>
      {account.currencyCode === 'VES' ? (
        account.currentValueUsd === null ? (
          <p className="mt-0.5 text-[11px] text-orange-200">Sin tasa</p>
        ) : (
          <p className="mt-0.5 whitespace-nowrap text-[11px] text-[#83838F]">
            ≈ {formatUsd(account.currentValueUsd)}
          </p>
        )
      ) : null}
    </div>
  );
}

function AnchorValue({ account }: { account: AdminFinanceAccountSnapshot }) {
  if (account.anchorKind === 'none') {
    return <span className="text-xs font-semibold text-orange-200">Sin ancla</span>;
  }

  return (
    <div>
      <p className="text-xs font-semibold text-[#D8D8DF]">
        {account.anchorKind === 'closure' ? 'Cierre' : 'Base'}
      </p>
      <p className="mt-0.5 text-[11px] text-[#83838F]">{formatDate(account.anchorDate)}</p>
    </div>
  );
}

export function AccountsOverview({ overview, filters, basePath }: AccountsOverviewProps) {
  const rootPath = normalizeBasePath(basePath);
  const result = filterAdminFinanceAccounts(overview.accounts, filters);
  const missingAnchors = {
    USD: Math.max(
      0,
      overview.summary.nativeUsdTotalAccounts - overview.summary.nativeUsdCoveredAccounts
    ),
    VES: Math.max(
      0,
      overview.summary.nativeVesTotalAccounts - overview.summary.nativeVesCoveredAccounts
    ),
  };
  const missingAnchorTotal = missingAnchors.USD + missingAnchors.VES;
  const hasFilters =
    Boolean(filters.q) ||
    filters.group !== 'all' ||
    filters.currency !== 'all' ||
    filters.state !== 'active' ||
    filters.quality !== 'all' ||
    filters.attention !== 'all' ||
    filters.sort !== 'attention';

  return (
    <div className="space-y-4" data-definition-version={overview.definitionVersion}>
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">Cuentas</h1>
          <p className="mt-1 text-xs text-[#81818E]">
            {overview.summary.activeAccounts} activas · {overview.summary.inactiveAccounts} inactivas
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 text-xs text-[#898996]">
          {overview.activeRateBsPerUsd === null ? (
            <span className="rounded-full border border-orange-300/20 bg-orange-300/5 px-2.5 py-1 text-orange-200">
              Sin tasa activa
            </span>
          ) : (
            <span
              className="rounded-full border border-[#30303D] bg-[#15151C] px-2.5 py-1 tabular-nums"
              title={overview.activeRateEffectiveAt ? `Vigente desde ${formatAsOf(overview.activeRateEffectiveAt)}` : undefined}
            >
              1 USD = {rateFormatter.format(overview.activeRateBsPerUsd)} Bs
            </span>
          )}
          <time dateTime={overview.asOf}>{formatAsOf(overview.asOf)}</time>
        </div>
      </header>

      <section aria-label="Resumen de cuentas" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <OverviewKpi
          label="Saldo nativo USD"
          value={formatNative(overview.summary.nativeUsdTotal, 'USD')}
          detail={missingAnchors.USD > 0 ? `Parcial · ${missingAnchors.USD} sin ancla` : undefined}
          help="Suma de los saldos confirmados de cuentas activas denominadas en USD. No representa caja libre."
          tone={missingAnchors.USD > 0 ? 'warning' : 'neutral'}
        />
        <OverviewKpi
          label="Saldo nativo VES"
          value={formatNative(overview.summary.nativeVesTotal, 'VES')}
          detail={missingAnchors.VES > 0 ? `Parcial · ${missingAnchors.VES} sin ancla` : undefined}
          help="Suma de los saldos confirmados de cuentas activas denominadas en VES, sin convertir ni mezclar monedas."
          tone={missingAnchors.VES > 0 ? 'warning' : 'neutral'}
        />
        <OverviewKpi
          label="Con ancla"
          value={`${overview.summary.anchoredAccounts}/${overview.summary.activeAccounts}`}
          detail={
            overview.summary.activeAccounts === 0
              ? 'Sin cuentas activas'
              : missingAnchorTotal > 0
                ? `${missingAnchorTotal} sin ancla`
                : 'Cobertura completa'
          }
          tone={missingAnchorTotal > 0 ? 'warning' : 'neutral'}
        />
        <OverviewKpi
          label="Atención"
          value={String(overview.summary.attentionAccounts)}
          detail={`${overview.summary.openReconciliations} conciliaciones · ${overview.summary.pendingMovementOperations} mov.`}
        />
      </section>

      <form
        action={rootPath}
        method="get"
        className="grid gap-2 rounded-xl border border-[#292937] bg-[#111117] p-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(180px,1fr)_repeat(6,minmax(105px,auto))_auto]"
      >
        <label className="min-w-0">
          <span className="sr-only">Buscar cuenta</span>
          <input
            type="search"
            name="q"
            defaultValue={filters.q}
            placeholder="Buscar cuenta"
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-3 text-sm text-white outline-none placeholder:text-[#6F6F7C] focus:border-[#FEEF00]/60"
          />
        </label>
        <label>
          <span className="sr-only">Grupo</span>
          <select
            name="grupo"
            defaultValue={filters.group}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Todos los grupos</option>
            {Object.entries(FINANCE_WORKSTREAM_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Moneda</span>
          <select
            name="moneda"
            defaultValue={filters.currency}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Toda moneda</option>
            <option value="USD">USD</option>
            <option value="VES">VES</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Estado de cuenta</span>
          <select
            name="estado"
            defaultValue={filters.state}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="active">Activas</option>
            <option value="inactive">Inactivas</option>
            <option value="all">Todas</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Calidad</span>
          <select
            name="calidad"
            defaultValue={filters.quality}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Toda calidad</option>
            <option value="exact">Exacto</option>
            <option value="derived">Derivado</option>
            <option value="incomplete">Parcial</option>
            <option value="blocked">No disponible</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Orden</span>
          <select
            name="orden"
            defaultValue={filters.sort}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="attention">Atención primero</option>
            <option value="balance_desc">Mayor saldo</option>
            <option value="name">Nombre</option>
          </select>
        </label>
        <label>
          <span className="sr-only">Atención</span>
          <select
            name="state"
            defaultValue={filters.attention}
            className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
          >
            <option value="all">Toda atención</option>
            <option value="pending_movements">Movimientos</option>
            <option value="open_reconciliation">Conciliaciones</option>
            <option value="no_anchor">Sin ancla</option>
            <option value="orphaned_reconciliation">Origen faltante</option>
          </select>
        </label>
        <button
          type="submit"
          className="h-10 rounded-lg bg-[#FEEF00] px-4 text-xs font-black text-[#0B0B0D] transition hover:bg-[#fff45a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
        >
          Aplicar
        </button>
      </form>

      <div className="flex min-h-6 items-center justify-between gap-3 text-xs text-[#848491]">
        <span>{result.total} cuentas</span>
        {hasFilters ? (
          <Link href={rootPath} prefetch={false} className="font-semibold text-[#CFCFD7] hover:text-white">
            Limpiar filtros
          </Link>
        ) : null}
      </div>

      {result.accounts.length === 0 ? (
        <section className="rounded-xl border border-dashed border-[#333341] px-4 py-8 text-center">
          <p className="text-sm font-semibold text-[#C8C8D1]">Sin cuentas para estos filtros</p>
          {hasFilters ? (
            <Link href={rootPath} prefetch={false} className="mt-2 inline-flex text-xs font-semibold text-[#FEEF00]">
              Limpiar
            </Link>
          ) : null}
        </section>
      ) : (
        <>
          <div className="hidden overflow-hidden rounded-xl border border-[#292937] bg-[#111117] lg:block">
            <table className="w-full table-fixed text-left text-xs">
              <thead className="border-b border-[#292937] bg-[#15151C] text-[10px] font-bold uppercase tracking-[0.1em] text-[#81818D]">
                <tr>
                  <th className="w-[25%] px-3 py-2.5">Cuenta</th>
                  <th className="w-[9%] px-3 py-2.5">Tipo</th>
                  <th className="w-[17%] px-3 py-2.5">Saldo</th>
                  <th className="w-[12%] px-3 py-2.5">Ancla</th>
                  <th className="w-[14%] px-3 py-2.5">Pendiente</th>
                  <th className="w-[14%] px-3 py-2.5">Conciliar</th>
                  <th className="w-[9%] px-3 py-2.5">Calidad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#252531]">
                {result.accounts.map((account) => (
                  <tr key={account.id} className="group transition hover:bg-[#17171F]">
                    <td className="px-3 py-3">
                      <Link
                        href={accountHref(rootPath, account.id, filters.attention)}
                        prefetch={false}
                        className="block rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
                      >
                        <AccountIdentity account={account} />
                      </Link>
                    </td>
                    <td className="px-3 py-3 text-[#B1B1BC]">{singularWorkstreamLabels[account.workstream]}</td>
                    <td className="px-3 py-3"><BalanceValue account={account} /></td>
                    <td className="px-3 py-3"><AnchorValue account={account} /></td>
                    <td className="px-3 py-3 tabular-nums">
                      <p className={account.pendingMovementOperations > 0 ? 'font-semibold text-orange-200' : 'text-[#C9C9D2]'}>
                        {account.pendingMovementOperations > 0
                          ? formatNative(account.pendingMovementNative, account.currencyCode)
                          : '—'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#777784]">{account.pendingMovementOperations} op.</p>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <p className={account.openReconciliations > 0 ? 'font-semibold text-orange-200' : 'text-[#C9C9D2]'}>
                        {account.openReconciliations > 0
                          ? formatNative(account.openReconciliationNative, account.currencyCode)
                          : '—'}
                      </p>
                      <p className="mt-0.5 text-[11px] text-[#777784]">{account.openReconciliations} abiertas</p>
                    </td>
                    <td className="px-3 py-3"><AdminQualityIndicator quality={account.quality} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-2 lg:hidden">
            {result.accounts.map((account) => (
              <Link
                key={account.id}
                href={accountHref(rootPath, account.id, filters.attention)}
                prefetch={false}
                className="rounded-xl border border-[#292937] bg-[#111117] p-3.5 transition hover:border-[#FEEF00]/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
              >
                <div className="flex items-start justify-between gap-3">
                  <AccountIdentity account={account} />
                  <AdminQualityIndicator quality={account.quality} className="shrink-0" />
                </div>
                <div className="mt-3 flex items-end justify-between gap-3 border-b border-[#272734] pb-3">
                  <BalanceValue account={account} />
                  <span className="shrink-0 text-[11px] font-semibold text-[#888895]">
                    {singularWorkstreamLabels[account.workstream]} · {account.currencyCode}
                  </span>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2">
                  <div className="min-w-0">
                    <dt className="text-[9px] font-bold uppercase tracking-[0.08em] text-[#71717D]">Ancla</dt>
                    <dd className="mt-1 truncate text-xs font-semibold text-[#D5D5DD]">
                      {account.anchorKind === 'none' ? 'Sin ancla' : formatDate(account.anchorDate)}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[9px] font-bold uppercase tracking-[0.08em] text-[#71717D]">Pendiente</dt>
                    <dd className={`mt-1 truncate text-xs font-semibold tabular-nums ${account.pendingMovementOperations > 0 ? 'text-orange-200' : 'text-[#D5D5DD]'}`}>
                      {account.pendingMovementOperations > 0
                        ? formatNative(account.pendingMovementNative, account.currencyCode)
                        : '—'}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-[9px] font-bold uppercase tracking-[0.08em] text-[#71717D]">Conciliar</dt>
                    <dd className={`mt-1 truncate text-xs font-semibold tabular-nums ${account.openReconciliations > 0 ? 'text-orange-200' : 'text-[#D5D5DD]'}`}>
                      {account.openReconciliations}
                    </dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        </>
      )}

      {result.total > 0 && result.page > 0 ? (
        <nav aria-label="Paginación de cuentas" className="flex items-center justify-between gap-3 border-t border-[#252531] pt-3">
          {result.page > 1 ? (
            <Link
              href={overviewHref(rootPath, filters, { page: result.page - 1 })}
              prefetch={false}
              className="inline-flex min-h-9 items-center rounded-lg border border-[#30303D] px-3 text-xs font-semibold text-[#D5D5DD] hover:border-[#FEEF00]/40"
            >
              ← Anterior
            </Link>
          ) : (
            <span />
          )}
          <span className="text-xs tabular-nums text-[#858592]">
            {result.page} / {Math.max(1, Math.ceil(result.total / 25))}
          </span>
          {result.page < Math.ceil(result.total / 25) ? (
            <Link
              href={overviewHref(rootPath, filters, { page: result.page + 1 })}
              prefetch={false}
              className="inline-flex min-h-9 items-center rounded-lg border border-[#30303D] px-3 text-xs font-semibold text-[#D5D5DD] hover:border-[#FEEF00]/40"
            >
              Siguiente →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </div>
  );
}

export default AccountsOverview;
export type { AccountsOverviewProps };
