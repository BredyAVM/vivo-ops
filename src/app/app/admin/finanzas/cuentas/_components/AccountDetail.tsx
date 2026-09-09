import Link from 'next/link';
import AdminQualityIndicator from '@/app/app/admin/_components/AdminQualityIndicator';
import type {
  AdminFinanceAccountDetail,
  AdminFinanceAccountSection,
  AdminFinanceAccountSnapshot,
  AdminFinanceClosureRow,
  AdminFinanceMovementRow,
  AdminFinanceReconciliationRow,
} from '@/lib/admin-finance/accounts-model';
import {
  MONEY_ACCOUNT_CLOSURE_LABELS,
  MONEY_ACCOUNT_KIND_LABELS,
} from '@/lib/domain/finance-domain';

type AccountDetailProps = {
  detail: AdminFinanceAccountDetail;
  basePath: string;
};

type DetailQuery = {
  section: AdminFinanceAccountSection;
  fromDate: string;
  toDate: string;
  status: string;
  page: number;
};

const amountFormatter = new Intl.NumberFormat('es-VE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
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

const sectionOptions: Array<{ key: AdminFinanceAccountSection; label: string }> = [
  { key: 'movements', label: 'Movimientos' },
  { key: 'closures', label: 'Cierres' },
  { key: 'reconciliation', label: 'Conciliación' },
  { key: 'configuration', label: 'Configuración' },
];

const workstreamLabels: Record<AdminFinanceAccountSnapshot['workstream'], string> = {
  bank: 'Banco',
  pos: 'Punto',
  cash: 'Caja',
  wallet: 'Wallet',
  retention: 'Retenciones',
  fund: 'Fondo',
  other: 'Otra cuenta',
};

const movementTypeLabels: Record<string, string> = {
  order_payment: 'Cobro de pedido',
  expense_payment: 'Pago de gasto',
  change_given: 'Vuelto',
  fee_charge: 'Comisión',
  transfer: 'Traspaso',
  transfer_in: 'Traspaso recibido',
  transfer_out: 'Traspaso enviado',
  withdrawal: 'Retiro',
  deposit: 'Depósito',
  adjustment: 'Ajuste',
  cash_count_adjustment: 'Ajuste de caja',
  other_income: 'Otro ingreso',
};

const closureStatusLabels: Record<AdminFinanceClosureRow['status'], string> = {
  recorded: 'Registrado',
  approved: 'Aprobado',
  rejected: 'Rechazado',
};

const movementStatusLabels: Record<AdminFinanceMovementRow['status'], string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmado',
  rejected: 'Rechazado',
  voided: 'Anulado',
};

const reconciliationStatusLabels: Record<AdminFinanceReconciliationRow['status'], string> = {
  open: 'Abierta',
  resolved: 'Resuelta',
  voided: 'Anulada',
};

const statusOptions: Record<Exclude<AdminFinanceAccountSection, 'configuration'>, Array<{ value: string; label: string }>> = {
  movements: [
    { value: 'all', label: 'Todo estado' },
    { value: 'pending', label: 'Pendiente' },
    { value: 'confirmed', label: 'Confirmado' },
    { value: 'rejected', label: 'Rechazado' },
    { value: 'voided', label: 'Anulado' },
  ],
  closures: [
    { value: 'all', label: 'Todo estado' },
    { value: 'recorded', label: 'Registrado' },
    { value: 'approved', label: 'Aprobado' },
    { value: 'rejected', label: 'Rechazado' },
  ],
  reconciliation: [
    { value: 'all', label: 'Todo estado' },
    { value: 'open', label: 'Abierta' },
    { value: 'resolved', label: 'Resuelta' },
    { value: 'voided', label: 'Anulada' },
  ],
};

function normalizeBasePath(basePath: string) {
  return basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
}

function formatNative(value: number, currencyCode: 'USD' | 'VES') {
  return currencyCode === 'USD' ? `$${amountFormatter.format(value)}` : `Bs ${amountFormatter.format(value)}`;
}

function formatUsd(value: number) {
  return `$${amountFormatter.format(value)}`;
}

function formatDate(value: string | null) {
  if (!value) return '—';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(dateOnly ? `${value}T12:00:00-04:00` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormatter.format(date);
}

function formatAsOf(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

function detailHref(basePath: string, accountId: number, query: DetailQuery, overrides: Partial<DetailQuery>) {
  const next = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (next.section !== 'movements') params.set('vista', next.section);
  if (next.fromDate) params.set('desde', next.fromDate);
  if (next.toDate) params.set('hasta', next.toDate);
  if (next.status && next.status !== 'all') params.set('estado', next.status);
  if (next.page > 1) params.set('page', String(next.page));
  const queryString = params.toString();
  const path = `${normalizeBasePath(basePath)}/${accountId}`;
  return queryString ? `${path}?${queryString}` : path;
}

function statusClass(status: string) {
  if (status === 'confirmed' || status === 'approved' || status === 'resolved') {
    return 'border-emerald-400/20 bg-emerald-400/8 text-emerald-200';
  }
  if (status === 'pending' || status === 'recorded' || status === 'open') {
    return 'border-orange-400/20 bg-orange-400/8 text-orange-200';
  }
  if (status === 'rejected' || status === 'voided') {
    return 'border-red-400/20 bg-red-400/8 text-red-200';
  }
  return 'border-[#3A3A47] bg-[#1A1A22] text-[#BDBDC7]';
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold ${statusClass(status)}`}>
      {label}
    </span>
  );
}

function DetailKpi({
  label,
  value,
  detail,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  detail?: string;
  tone?: 'neutral' | 'positive' | 'warning';
}) {
  const valueClass = tone === 'positive' ? 'text-emerald-200' : tone === 'warning' ? 'text-orange-200' : 'text-white';
  return (
    <div className="min-w-0 rounded-xl border border-[#292937] bg-[#111117] px-3 py-3 sm:px-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-[#858592]">{label}</p>
      <p className={`mt-1.5 text-[clamp(0.95rem,4vw,1.25rem)] font-semibold leading-tight tabular-nums [overflow-wrap:anywhere] ${valueClass}`}>{value}</p>
      {detail ? <p className="mt-1.5 truncate text-[11px] text-[#7D7D89]">{detail}</p> : null}
    </div>
  );
}

function ConvertedValue({ native, usd, currencyCode }: { native: number; usd: number; currencyCode: 'USD' | 'VES' }) {
  return (
    <div>
      <p className="whitespace-nowrap font-semibold tabular-nums text-white">{formatNative(native, currencyCode)}</p>
      {currencyCode === 'VES' ? (
        <p className="mt-0.5 whitespace-nowrap text-[10px] tabular-nums text-[#777784]">≈ {formatUsd(usd)}</p>
      ) : null}
    </div>
  );
}

function MovementRows({ rows }: { rows: AdminFinanceMovementRow[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-[#292937] bg-[#111117] md:block">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-[#292937] bg-[#15151C] text-[10px] font-bold uppercase tracking-[0.1em] text-[#81818D]">
            <tr>
              <th className="w-[13%] px-3 py-2.5">Fecha</th>
              <th className="w-[29%] px-3 py-2.5">Movimiento</th>
              <th className="w-[18%] px-3 py-2.5">Referencia</th>
              <th className="w-[15%] px-3 py-2.5">Entrada</th>
              <th className="w-[15%] px-3 py-2.5">Salida</th>
              <th className="w-[10%] px-3 py-2.5">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#252531]">
            {rows.map((row) => {
              const title = row.counterpartyName || row.description || movementTypeLabels[row.movementType] || row.movementType;
              return (
                <tr key={row.id} className="hover:bg-[#17171F]">
                  <td className="px-3 py-3 text-[#BDBDC7]">{formatDate(row.movementDate)}</td>
                  <td className="px-3 py-3">
                    <p className="truncate font-semibold text-white">{title}</p>
                    <p className="mt-0.5 truncate text-[11px] text-[#777784]">
                      {movementTypeLabels[row.movementType] || row.movementType}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-[#A7A7B2]">
                    <p className="truncate">{row.referenceCode || '—'}</p>
                    {row.orderId ? (
                      <Link
                        href={`/app/master/ops?openOrder=${row.orderId}&tab=pagos`}
                        prefetch={false}
                        className="mt-0.5 inline-flex text-[10px] font-semibold text-[#A6A6B0] hover:text-white"
                      >
                        Pedido #{row.orderId} →
                      </Link>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-emerald-200">
                    {row.direction === 'inflow' ? (
                      <ConvertedValue native={row.amount} usd={row.amountUsdEquivalent} currencyCode={row.currencyCode} />
                    ) : '—'}
                  </td>
                  <td className="px-3 py-3 text-orange-200">
                    {row.direction === 'outflow' ? (
                      <ConvertedValue native={row.amount} usd={row.amountUsdEquivalent} currencyCode={row.currencyCode} />
                    ) : '—'}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={row.status} label={movementStatusLabels[row.status]} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 md:hidden">
        {rows.map((row) => {
          const title = row.counterpartyName || row.description || movementTypeLabels[row.movementType] || row.movementType;
          const isInflow = row.direction === 'inflow';
          return (
            <article key={row.id} className="rounded-xl border border-[#292937] bg-[#111117] p-3.5">
              <div className="flex items-start justify-between gap-3">
                <time className="text-[11px] text-[#858592]" dateTime={row.movementDate}>{formatDate(row.movementDate)}</time>
                <StatusBadge status={row.status} label={movementStatusLabels[row.status]} />
              </div>
              <div className="mt-2.5 flex items-end justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-white">{title}</p>
                  <p className="mt-0.5 truncate text-[11px] text-[#777784]">
                    {row.referenceCode || movementTypeLabels[row.movementType] || row.movementType}
                  </p>
                  {row.orderId ? (
                    <Link
                      href={`/app/master/ops?openOrder=${row.orderId}&tab=pagos`}
                      prefetch={false}
                      className="mt-1 inline-flex text-[10px] font-semibold text-[#A6A6B0]"
                    >
                      Pedido #{row.orderId} →
                    </Link>
                  ) : null}
                </div>
                <div className={`shrink-0 text-right ${isInflow ? 'text-emerald-200' : 'text-orange-200'}`}>
                  <p className="text-sm font-semibold tabular-nums">
                    {isInflow ? '+' : '−'}{formatNative(row.amount, row.currencyCode)}
                  </p>
                  {row.currencyCode === 'VES' ? (
                    <p className="mt-0.5 text-[10px] tabular-nums text-[#777784]">≈ {formatUsd(row.amountUsdEquivalent)}</p>
                  ) : null}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </>
  );
}

function ClosureRows({ rows }: { rows: AdminFinanceClosureRow[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-[#292937] bg-[#111117] md:block">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-[#292937] bg-[#15151C] text-[10px] font-bold uppercase tracking-[0.1em] text-[#81818D]">
            <tr>
              <th className="w-[18%] px-3 py-2.5">Fecha</th>
              <th className="w-[22%] px-3 py-2.5">Sistema</th>
              <th className="w-[22%] px-3 py-2.5">Contado</th>
              <th className="w-[22%] px-3 py-2.5">Diferencia</th>
              <th className="w-[16%] px-3 py-2.5">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#252531]">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-[#17171F]">
                <td className="px-3 py-3 text-[#BDBDC7]">{formatDate(row.closureDate)}</td>
                <td className="px-3 py-3"><ConvertedValue native={row.expectedAmount} usd={row.expectedAmountUsd} currencyCode={row.currencyCode} /></td>
                <td className="px-3 py-3"><ConvertedValue native={row.countedAmount} usd={row.countedAmountUsd} currencyCode={row.currencyCode} /></td>
                <td className={`px-3 py-3 ${Math.abs(row.differenceAmount) > 0.005 ? 'text-orange-200' : 'text-emerald-200'}`}>
                  <ConvertedValue native={row.differenceAmount} usd={row.differenceAmountUsd} currencyCode={row.currencyCode} />
                </td>
                <td className="px-3 py-3"><StatusBadge status={row.status} label={closureStatusLabels[row.status]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 md:hidden">
        {rows.map((row) => (
          <article key={row.id} className="rounded-xl border border-[#292937] bg-[#111117] p-3.5">
            <div className="flex items-start justify-between gap-3">
              <time className="text-[11px] text-[#858592]" dateTime={row.closureDate}>{formatDate(row.closureDate)}</time>
              <StatusBadge status={row.status} label={closureStatusLabels[row.status]} />
            </div>
            <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-[#272734] pt-3">
              <div className="min-w-0">
                <dt className="text-[9px] font-bold uppercase text-[#71717D]">Sistema</dt>
                <dd className="mt-1 truncate text-xs font-semibold text-white tabular-nums">{formatNative(row.expectedAmount, row.currencyCode)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[9px] font-bold uppercase text-[#71717D]">Contado</dt>
                <dd className="mt-1 truncate text-xs font-semibold text-white tabular-nums">{formatNative(row.countedAmount, row.currencyCode)}</dd>
              </div>
              <div className="min-w-0">
                <dt className="text-[9px] font-bold uppercase text-[#71717D]">Diferencia</dt>
                <dd className={`mt-1 truncate text-xs font-semibold tabular-nums ${Math.abs(row.differenceAmount) > 0.005 ? 'text-orange-200' : 'text-emerald-200'}`}>
                  {formatNative(row.differenceAmount, row.currencyCode)}
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}

function ReconciliationRows({ rows }: { rows: AdminFinanceReconciliationRow[] }) {
  return (
    <>
      <div className="hidden overflow-hidden rounded-xl border border-[#292937] bg-[#111117] md:block">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-[#292937] bg-[#15151C] text-[10px] font-bold uppercase tracking-[0.1em] text-[#81818D]">
            <tr>
              <th className="w-[16%] px-3 py-2.5">Fecha</th>
              <th className="w-[30%] px-3 py-2.5">Partida</th>
              <th className="w-[20%] px-3 py-2.5">Importe</th>
              <th className="w-[18%] px-3 py-2.5">Referencia</th>
              <th className="w-[16%] px-3 py-2.5">Estado</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#252531]">
            {rows.map((row) => (
              <tr key={row.id} className="hover:bg-[#17171F]">
                <td className="px-3 py-3 text-[#BDBDC7]">{formatDate(row.operationDate || row.createdAt)}</td>
                <td className="px-3 py-3">
                  <p className="truncate font-semibold text-white">{row.description}</p>
                  <p className="mt-0.5 truncate text-[11px] text-[#777784]">
                    {row.direction === 'surplus' ? 'Sobrante' : 'Faltante'} · {row.itemType}
                  </p>
                </td>
                <td className="px-3 py-3"><ConvertedValue native={row.amount} usd={row.amountUsdEquivalent} currencyCode={row.currencyCode} /></td>
                <td className="px-3 py-3">
                  <p className="truncate text-[#A7A7B2]">{row.referenceCode || '—'}</p>
                  {row.orphanedSource ? <p className="mt-0.5 text-[10px] font-semibold text-orange-200">Origen faltante</p> : null}
                </td>
                <td className="px-3 py-3"><StatusBadge status={row.status} label={reconciliationStatusLabels[row.status]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-2 md:hidden">
        {rows.map((row) => (
          <article key={row.id} className="rounded-xl border border-[#292937] bg-[#111117] p-3.5">
            <div className="flex items-start justify-between gap-3">
              <time className="text-[11px] text-[#858592]" dateTime={row.operationDate || row.createdAt}>
                {formatDate(row.operationDate || row.createdAt)}
              </time>
              <StatusBadge status={row.status} label={reconciliationStatusLabels[row.status]} />
            </div>
            <div className="mt-2.5 flex items-end justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-white">{row.description}</p>
                <p className="mt-0.5 truncate text-[11px] text-[#777784]">
                  {row.direction === 'surplus' ? 'Sobrante' : 'Faltante'} · {row.referenceCode || row.itemType}
                </p>
                {row.orphanedSource ? <p className="mt-1 text-[10px] font-semibold text-orange-200">Origen faltante</p> : null}
              </div>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-orange-200">{formatNative(row.amount, row.currencyCode)}</p>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}

function Configuration({ detail }: { detail: AdminFinanceAccountDetail }) {
  const account = detail.account;
  const closureKind = account.closureKind ? MONEY_ACCOUNT_CLOSURE_LABELS[account.closureKind] : 'Sin regla';
  const accountKind = MONEY_ACCOUNT_KIND_LABELS[account.accountKind];
  const values: Array<{ label: string; value: string; tone?: 'warning' }> = [
    { label: 'Estado', value: account.isActive ? 'Activa' : 'Inactiva' },
    { label: 'Moneda', value: account.currencyCode },
    { label: 'Tipo', value: accountKind },
    { label: 'Operación', value: closureKind },
    { label: 'Institución', value: account.institutionName || '—' },
    { label: 'Titular', value: account.ownerName || '—' },
    { label: 'Línea base', value: account.baselineRequired ? 'Requerida' : 'No requerida' },
    {
      label: 'Ancla actual',
      value: account.anchorKind === 'none' ? 'Sin ancla' : `${account.anchorKind === 'closure' ? 'Cierre' : 'Base'} · ${formatDate(account.anchorDate)}`,
      tone: account.anchorKind === 'none' ? 'warning' : undefined,
    },
    { label: 'Último cierre', value: formatDate(account.latestClosureDate) },
    { label: 'Equiv. histórica', value: formatUsd(account.ledgerValueUsd) },
  ];

  return (
    <section className="overflow-hidden rounded-xl border border-[#292937] bg-[#111117]">
      <dl className="grid sm:grid-cols-2">
        {values.map((item) => (
          <div key={item.label} className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 border-b border-[#252531] px-3 py-3 last:border-b-0 sm:[&:nth-last-child(-n+2)]:border-b-0 sm:even:border-l">
            <dt className="text-xs text-[#7F7F8C]">{item.label}</dt>
            <dd className={`truncate text-right text-xs font-semibold ${item.tone === 'warning' ? 'text-orange-200' : 'text-[#D8D8DF]'}`} title={item.value}>
              {item.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function AccountDetail({ detail, basePath }: AccountDetailProps) {
  const account = detail.account;
  const rootPath = normalizeBasePath(basePath);
  const query: DetailQuery = {
    section: detail.section,
    fromDate: detail.fromDate,
    toDate: detail.toDate,
    status: detail.status,
    page: detail.page,
  };
  const pageCount = Math.max(1, Math.ceil(detail.totalRows / detail.pageSize));
  const movements = detail.rows.filter((row): row is AdminFinanceMovementRow => row.kind === 'movement');
  const closures = detail.rows.filter((row): row is AdminFinanceClosureRow => row.kind === 'closure');
  const reconciliations = detail.rows.filter((row): row is AdminFinanceReconciliationRow => row.kind === 'reconciliation');
  const visibleRows = detail.section === 'movements' ? movements.length : detail.section === 'closures' ? closures.length : reconciliations.length;

  return (
    <div className="space-y-4" data-definition-version={detail.definitionVersion}>
      <header className="grid gap-3 border-b border-[#252531] pb-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <div className="min-w-0">
          <Link href={rootPath} prefetch={false} className="inline-flex text-xs font-semibold text-[#8C8C99] hover:text-white">
            ← Cuentas
          </Link>
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight text-white sm:text-2xl">{account.name}</h1>
            <AdminQualityIndicator quality={account.quality} />
          </div>
          <p className="mt-1 text-xs text-[#81818E]">
            {workstreamLabels[account.workstream]} · {account.currencyCode} · {account.isActive ? 'Activa' : 'Inactiva'}
          </p>
        </div>
        <div className="min-w-0 lg:text-right">
          <p className={`mb-1 text-[10px] font-bold uppercase tracking-[0.12em] ${account.anchorKind === 'none' ? 'text-orange-200' : 'text-[#858592]'}`}>
            {account.anchorKind === 'none' ? 'Saldo parcial' : 'Saldo confirmado'}
          </p>
          <p className="text-[clamp(1.55rem,7vw,2.25rem)] font-semibold leading-none tracking-[-0.04em] text-white tabular-nums [overflow-wrap:anywhere]">
            {formatNative(account.balanceNative, account.currencyCode)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[#7D7D89] lg:justify-end">
            {account.currencyCode === 'VES' && account.currentValueUsd !== null ? <span>≈ {formatUsd(account.currentValueUsd)}</span> : null}
            <time dateTime={detail.asOf}>{formatAsOf(detail.asOf)}</time>
          </div>
        </div>
      </header>

      <section aria-label="Estado de la cuenta" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <DetailKpi
          label="Última ancla"
          value={account.anchorKind === 'none' ? 'Sin ancla' : formatDate(account.anchorDate)}
          detail={account.anchorKind === 'closure' ? 'Cierre' : account.anchorKind === 'baseline' ? 'Línea base' : undefined}
          tone={account.anchorKind === 'none' ? 'warning' : 'neutral'}
        />
        <DetailKpi
          label="Pendiente"
          value={formatNative(account.pendingMovementNative, account.currencyCode)}
          detail={`${account.pendingMovementOperations} op.`}
          tone={account.pendingMovementOperations > 0 ? 'warning' : 'neutral'}
        />
        <DetailKpi
          label="Por conciliar"
          value={formatNative(account.openReconciliationNative, account.currencyCode)}
          detail={`${account.openReconciliations} abiertas`}
          tone={account.openReconciliations > 0 ? 'warning' : 'neutral'}
        />
        <DetailKpi
          label="Diferencia cierre"
          value={
            account.latestClosureDifference === null
              ? '—'
              : formatNative(account.latestClosureDifference, account.currencyCode)
          }
          detail={
            account.latestClosureDate
              ? `${formatDate(account.latestClosureDate)}${account.latestClosureStatus ? ` · ${closureStatusLabels[account.latestClosureStatus]}` : ''}`
              : 'Sin cierre'
          }
          tone={
            account.latestClosureStatus === 'rejected' ||
            (account.latestClosureDifference !== null && Math.abs(account.latestClosureDifference) > 0.005)
              ? 'warning'
              : 'neutral'
          }
        />
      </section>

      <nav aria-label="Detalle de cuenta" className="flex gap-1 overflow-x-auto border-b border-[#292937]">
        {sectionOptions.map((option) => {
          const selected = option.key === detail.section;
          return (
            <Link
              key={option.key}
              href={detailHref(rootPath, account.id, query, {
                section: option.key,
                fromDate: '',
                toDate: '',
                status: 'all',
                page: 1,
              })}
              prefetch={false}
              aria-current={selected ? 'page' : undefined}
              className={`shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#FEEF00] ${selected ? 'border-[#FEEF00] text-white' : 'border-transparent text-[#858592] hover:text-white'}`}
            >
              {option.label}
            </Link>
          );
        })}
      </nav>

      {detail.section !== 'configuration' ? (
        <form
          action={`${rootPath}/${account.id}`}
          method="get"
          className="grid gap-2 rounded-xl border border-[#292937] bg-[#111117] p-2 sm:grid-cols-[minmax(130px,1fr)_minmax(130px,1fr)_minmax(130px,0.8fr)_auto]"
        >
          {detail.section !== 'movements' ? <input type="hidden" name="vista" value={detail.section} /> : null}
          <label>
            <span className="sr-only">Desde</span>
            <input
              type="date"
              name="desde"
              defaultValue={detail.fromDate}
              className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
            />
          </label>
          <label>
            <span className="sr-only">Hasta</span>
            <input
              type="date"
              name="hasta"
              defaultValue={detail.toDate}
              className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
            />
          </label>
          <label>
            <span className="sr-only">Estado</span>
            <select
              name="estado"
              defaultValue={detail.status}
              className="h-10 w-full rounded-lg border border-[#30303D] bg-[#17171F] px-2.5 text-xs font-semibold text-[#D6D6DE] outline-none focus:border-[#FEEF00]/60"
            >
              {statusOptions[detail.section].map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <button
            type="submit"
            className="h-10 rounded-lg bg-[#FEEF00] px-4 text-xs font-black text-[#0B0B0D] transition hover:bg-[#fff45a] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            Aplicar
          </button>
        </form>
      ) : null}

      {detail.section === 'movements' ? (
        <section aria-label="Totales del período" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <DetailKpi label="Entradas" value={formatNative(detail.period.inflowNative, account.currencyCode)} tone="positive" />
          <DetailKpi label="Salidas" value={formatNative(detail.period.outflowNative, account.currencyCode)} />
          <DetailKpi
            label="Neto"
            value={formatNative(detail.period.netNative, account.currencyCode)}
            tone={detail.period.netNative >= 0 ? 'positive' : 'warning'}
          />
          <DetailKpi
            label="Pendiente"
            value={formatNative(detail.period.pendingNative, account.currencyCode)}
            tone={detail.period.pendingNative > 0 ? 'warning' : 'neutral'}
          />
        </section>
      ) : null}

      {detail.section === 'configuration' ? (
        <Configuration detail={detail} />
      ) : visibleRows === 0 ? (
        <section className="rounded-xl border border-dashed border-[#333341] px-4 py-8 text-center text-sm font-semibold text-[#BDBDC7]">
          Sin datos para estos filtros
        </section>
      ) : detail.section === 'movements' ? (
        <MovementRows rows={movements} />
      ) : detail.section === 'closures' ? (
        <ClosureRows rows={closures} />
      ) : (
        <ReconciliationRows rows={reconciliations} />
      )}

      {detail.section !== 'configuration' && detail.totalRows > 0 ? (
        <nav aria-label="Paginación del detalle" className="flex items-center justify-between gap-3 border-t border-[#252531] pt-3">
          {detail.page > 1 ? (
            <Link
              href={detailHref(rootPath, account.id, query, { page: detail.page - 1 })}
              prefetch={false}
              className="inline-flex min-h-9 items-center rounded-lg border border-[#30303D] px-3 text-xs font-semibold text-[#D5D5DD] hover:border-[#FEEF00]/40"
            >
              ← Anterior
            </Link>
          ) : <span />}
          <span className="text-xs tabular-nums text-[#858592]">{detail.page} / {pageCount}</span>
          {detail.page < pageCount ? (
            <Link
              href={detailHref(rootPath, account.id, query, { page: detail.page + 1 })}
              prefetch={false}
              className="inline-flex min-h-9 items-center rounded-lg border border-[#30303D] px-3 text-xs font-semibold text-[#D5D5DD] hover:border-[#FEEF00]/40"
            >
              Siguiente →
            </Link>
          ) : <span />}
        </nav>
      ) : null}

      {detail.section !== 'configuration' ? (
        <p className="sr-only">{detail.totalRows} registros en total.</p>
      ) : null}
    </div>
  );
}

export default AccountDetail;
export type { AccountDetailProps };
