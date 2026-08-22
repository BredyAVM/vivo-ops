import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { normalizePhoneDetailed } from '@/lib/phone/normalize-phone';
import { normalizeSearchValue, splitSearchTokens } from '@/lib/search/normalize-search';
import { EmptyBlock, PageIntro, StatusBadge } from '../advisor-ui';

type PortfolioRow = {
  client_id: number | string;
  client_name: string | null;
  phone: string | null;
  first_purchase_on: string | null;
  last_purchase_on: string | null;
  purchase_count: number | string;
  net_revenue_usd: number | string;
  average_ticket_usd: number | string | null;
  cadence_days: number | string | null;
  cadence_window_used: number | string;
  last_advisor_id: string | null;
  last_advisor_name_snapshot: string | null;
  last_gift_on: string | null;
  days_since_last_purchase: number | string | null;
  used_pickup: boolean;
  used_delivery: boolean;
};

type PortfolioSegment = 'all' | 'contact' | 'overdue' | 'new';
type PortfolioSort = 'attention' | 'recent' | 'revenue' | 'name';
type SearchParams = Promise<{
  q?: string;
  segment?: string;
  sort?: string;
  window?: string;
  page?: string;
}>;

const PAGE_SIZE = 40;
const CONTACT_AFTER_DAYS = 60;
const NEW_CLIENT_DAYS = 30;

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'America/Caracas',
});

const moneyFormatter = new Intl.NumberFormat('es-VE', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat('es-VE', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateLabel(value: string | null) {
  if (!value) return 'Sin compras';
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00-04:00`);
  return Number.isNaN(parsed.getTime()) ? value : dateFormatter.format(parsed);
}

function calendarDaysBetween(earlier: string | null, later: string) {
  if (!earlier) return null;
  const earlierParts = earlier.slice(0, 10).split('-').map(Number);
  const laterParts = later.slice(0, 10).split('-').map(Number);
  if (earlierParts.length !== 3 || laterParts.length !== 3) return null;
  const earlierUtc = Date.UTC(earlierParts[0], earlierParts[1] - 1, earlierParts[2]);
  const laterUtc = Date.UTC(laterParts[0], laterParts[1] - 1, laterParts[2]);
  return Math.floor((laterUtc - earlierUtc) / 86_400_000);
}

function isNewClient(row: PortfolioRow, todayKey: string) {
  const age = calendarDaysBetween(row.first_purchase_on, todayKey);
  return age !== null && age >= 0 && age <= NEW_CLIENT_DAYS;
}

function isOutsideRhythm(row: PortfolioRow) {
  const cadence = optionalNumber(row.cadence_days);
  const days = optionalNumber(row.days_since_last_purchase);
  return cadence !== null && cadence > 0 && days !== null && days > cadence;
}

function needsContact(row: PortfolioRow) {
  const days = optionalNumber(row.days_since_last_purchase);
  return !row.last_purchase_on || (days !== null && days >= CONTACT_AFTER_DAYS);
}

function segmentValue(value: string | undefined): PortfolioSegment {
  return value === 'contact' || value === 'overdue' || value === 'new' ? value : 'all';
}

function sortValue(value: string | undefined): PortfolioSort {
  return value === 'recent' || value === 'revenue' || value === 'name' ? value : 'attention';
}

function cadenceWindowValue(value: string | undefined) {
  return Number(value) === 10 ? 10 : 6;
}

function pageValue(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function portfolioHref(
  current: { q: string; segment: PortfolioSegment; sort: PortfolioSort; window: number; page: number },
  changes: Partial<{ q: string; segment: PortfolioSegment; sort: PortfolioSort; window: number; page: number }>
) {
  const next = { ...current, ...changes };
  const params = new URLSearchParams();
  if (next.q) params.set('q', next.q);
  if (next.segment !== 'all') params.set('segment', next.segment);
  if (next.sort !== 'attention') params.set('sort', next.sort);
  if (next.window !== 6) params.set('window', String(next.window));
  if (next.page > 1) params.set('page', String(next.page));
  const query = params.toString();
  return query ? `/app/advisor/clients?${query}` : '/app/advisor/clients';
}

function rowStatus(row: PortfolioRow, todayKey: string) {
  const days = optionalNumber(row.days_since_last_purchase);
  if (!row.last_purchase_on) return { label: 'Sin historial', tone: 'danger' as const };
  if (days !== null && days >= CONTACT_AFTER_DAYS) {
    return { label: `${Math.round(days)} días`, tone: 'danger' as const };
  }
  if (isOutsideRhythm(row)) return { label: 'Fuera de ritmo', tone: 'warning' as const };
  if (isNewClient(row, todayKey)) return { label: 'Cliente nuevo', tone: 'success' as const };
  return { label: 'Al día', tone: 'success' as const };
}

function channelLabel(row: PortfolioRow) {
  if (row.used_pickup && row.used_delivery) return 'Pickup y delivery';
  if (row.used_pickup) return 'Pickup';
  if (row.used_delivery) return 'Delivery';
  return 'Sin canal registrado';
}

function rhythmLabel(row: PortfolioRow) {
  const cadence = optionalNumber(row.cadence_days);
  if (cadence === null) return 'Aún sin patrón';
  return `Cada ${Math.round(cadence)} días`;
}

function daysLabel(row: PortfolioRow) {
  const days = optionalNumber(row.days_since_last_purchase);
  if (!row.last_purchase_on || days === null) return 'Aún sin compra visible';
  if (days <= 0) return 'Compró hoy';
  if (days === 1) return 'Hace 1 día';
  return `Hace ${Math.round(days)} días`;
}

function sortPortfolio(rows: PortfolioRow[], sort: PortfolioSort) {
  return [...rows].sort((left, right) => {
    if (sort === 'name') {
      return String(left.client_name || '').localeCompare(String(right.client_name || ''), 'es');
    }
    if (sort === 'revenue') {
      return numberValue(right.net_revenue_usd) - numberValue(left.net_revenue_usd);
    }
    if (sort === 'recent') {
      return String(right.last_purchase_on || '').localeCompare(String(left.last_purchase_on || ''));
    }

    const leftNoHistory = left.last_purchase_on ? 0 : 1;
    const rightNoHistory = right.last_purchase_on ? 0 : 1;
    if (leftNoHistory !== rightNoHistory) return rightNoHistory - leftNoHistory;

    const leftDays = optionalNumber(left.days_since_last_purchase) ?? -1;
    const rightDays = optionalNumber(right.days_since_last_purchase) ?? -1;
    if (leftDays !== rightDays) return rightDays - leftDays;
    return numberValue(right.net_revenue_usd) - numberValue(left.net_revenue_usd);
  });
}

function SummaryMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <article className="rounded-[18px] border border-[#232632] bg-[#12151D] px-3.5 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#8B93A7]">{label}</p>
      <p className="mt-1.5 text-[23px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{value}</p>
      <p className="mt-1 text-[11px] leading-4 text-[#AAB2C5]">{detail}</p>
    </article>
  );
}

export default async function AdvisorClientsPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const params = (await searchParams) ?? {};
  const query = String(params.q || '').trim().slice(0, 80);
  const segment = segmentValue(params.segment);
  const sort = sortValue(params.sort);
  const cadenceWindow = cadenceWindowValue(params.window);
  const requestedPage = pageValue(params.page);
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const result = await ctx.supabase.rpc('crm_my_client_portfolio_v1', {
    p_purchase_window: cadenceWindow,
  });

  if (result.error) {
    console.error('Unable to load advisor client portfolio', result.error.message);
    return (
      <div className="space-y-4">
        <PageIntro
          eyebrow="CRM del asesor"
          title="Tu cartera"
          description="Clientes asignados y señales comerciales actualizadas."
        />
        <EmptyBlock
          title="No pudimos cargar la cartera"
          detail="La información no fue modificada. Intenta abrir esta pantalla nuevamente."
        />
      </div>
    );
  }

  const rows = (result.data ?? []) as PortfolioRow[];
  const contactCount = rows.filter(needsContact).length;
  const overdueCount = rows.filter(isOutsideRhythm).length;
  const newCount = rows.filter((row) => isNewClient(row, todayKey)).length;
  const totalRevenue = rows.reduce((sum, row) => sum + numberValue(row.net_revenue_usd), 0);
  const queryTokens = splitSearchTokens(query);

  const segmentedRows = rows.filter((row) => {
    if (segment === 'contact') return needsContact(row);
    if (segment === 'overdue') return isOutsideRhythm(row);
    if (segment === 'new') return isNewClient(row, todayKey);
    return true;
  });

  const searchedRows = queryTokens.length
    ? segmentedRows.filter((row) => {
        const normalizedPhone = normalizePhoneDetailed(row.phone);
        const searchValue = normalizeSearchValue(
          `${row.client_name || ''} ${row.phone || ''} ${normalizedPhone.digits} ${normalizedPhone.e164 || ''}`
        );
        return queryTokens.every((token) => searchValue.includes(token));
      })
    : segmentedRows;

  const sortedRows = sortPortfolio(searchedRows, sort);
  const totalPages = Math.max(1, Math.ceil(sortedRows.length / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const visibleRows = sortedRows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const routeState = { q: query, segment, sort, window: cadenceWindow, page: currentPage };
  const segments: Array<{ value: PortfolioSegment; label: string; count: number }> = [
    { value: 'all', label: 'Todos', count: rows.length },
    { value: 'contact', label: 'Por contactar', count: contactCount },
    { value: 'overdue', label: 'Fuera de ritmo', count: overdueCount },
    { value: 'new', label: 'Nuevos', count: newCount },
  ];

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="CRM del asesor"
        title="Tu cartera"
        description="Clientes asignados con compras históricas y recientes actualizadas al momento."
        action={<StatusBadge label={`Ritmo ${cadenceWindow}`} tone="neutral" />}
      />

      <div className="grid grid-cols-2 gap-2">
        <SummaryMetric label="Asignados" value={String(rows.length)} detail="Clientes activos en tu cartera" />
        <SummaryMetric label="Por contactar" value={String(contactCount)} detail="60 días o sin historial visible" />
        <SummaryMetric label="Fuera de ritmo" value={String(overdueCount)} detail="Superaron su frecuencia habitual" />
        <SummaryMetric
          label="Facturación"
          value={`$${compactNumberFormatter.format(totalRevenue)}`}
          detail="Acumulado sin IVA de la cartera"
        />
      </div>

      <section className="rounded-[22px] border border-[#232632] bg-[#12151D] px-4 py-3.5">
        <form action="/app/advisor/clients" method="get" className="space-y-3">
          <div>
            <label htmlFor="portfolio-search" className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[#8B93A7]">
              Buscar cliente
            </label>
            <div className="mt-2 flex gap-2">
              <input
                id="portfolio-search"
                name="q"
                type="search"
                defaultValue={query}
                placeholder="Nombre o teléfono"
                className="h-11 min-w-0 flex-1 rounded-[14px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB] outline-none placeholder:text-[#646D80] focus:border-[#F0D000]"
              />
              <button
                type="submit"
                className="h-11 shrink-0 rounded-[14px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E]"
              >
                Buscar
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="text-[11px] text-[#8B93A7]">
              Ritmo de compra
              <select
                name="window"
                defaultValue={String(cadenceWindow)}
                className="mt-1.5 h-10 w-full rounded-[12px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
              >
                <option value="6">Últimas 6</option>
                <option value="10">Últimas 10</option>
              </select>
            </label>
            <label className="text-[11px] text-[#8B93A7]">
              Ordenar por
              <select
                name="sort"
                defaultValue={sort}
                className="mt-1.5 h-10 w-full rounded-[12px] border border-[#2A3040] bg-[#0D1017] px-3 text-sm text-[#F5F7FB]"
              >
                <option value="attention">Prioridad</option>
                <option value="recent">Compra reciente</option>
                <option value="revenue">Facturación</option>
                <option value="name">Nombre</option>
              </select>
            </label>
          </div>
          {segment !== 'all' ? <input type="hidden" name="segment" value={segment} /> : null}
        </form>

        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {segments.map((item) => {
            const active = item.value === segment;
            return (
              <Link
                key={item.value}
                href={portfolioHref(routeState, { segment: item.value, page: 1 })}
                aria-current={active ? 'page' : undefined}
                className={[
                  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium',
                  active
                    ? 'border-[#F0D000] bg-[#2B2708] text-[#F7DA66]'
                    : 'border-[#2A3040] bg-[#0D1017] text-[#AAB2C5]',
                ].join(' ')}
              >
                <span>{item.label}</span>
                <span className="text-[10px] opacity-75">{item.count}</span>
              </Link>
            );
          })}
        </div>

        <p className="mt-3 text-[11px] leading-4 text-[#747E91]">
          “Fuera de ritmo” significa que ya superó su promedio entre compras; es una señal de seguimiento, no una baja automática.
        </p>
      </section>

      <section className="space-y-2.5">
        <div className="flex items-end justify-between gap-3 px-1">
          <div>
            <h2 className="text-base font-semibold text-[#F5F7FB]">Clientes</h2>
            <p className="mt-0.5 text-xs text-[#8B93A7]">
              {sortedRows.length} resultado{sortedRows.length === 1 ? '' : 's'}
              {query ? ` para “${query}”` : ''}
            </p>
          </div>
          {query ? (
            <Link href={portfolioHref(routeState, { q: '', page: 1 })} className="text-xs font-semibold text-[#F7DA66]">
              Limpiar
            </Link>
          ) : null}
        </div>

        {visibleRows.length === 0 ? (
          <EmptyBlock
            title="Sin clientes en este filtro"
            detail="Prueba otro nombre, limpia la búsqueda o cambia la señal comercial seleccionada."
            href="/app/advisor/clients"
            cta="Ver toda la cartera"
          />
        ) : (
          visibleRows.map((row) => {
            const status = rowStatus(row, todayKey);
            const phone = normalizePhoneDetailed(row.phone);
            const whatsappHref = phone.e164 ? `https://wa.me/${phone.e164.slice(1)}` : null;
            const cadence = optionalNumber(row.cadence_days);
            const averageTicket = optionalNumber(row.average_ticket_usd);

            return (
              <article key={String(row.client_id)} className="rounded-[20px] border border-[#232632] bg-[#12151D] px-4 py-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-[#F5F7FB]">
                      {row.client_name?.trim() || 'Cliente sin nombre'}
                    </h3>
                    <p className="mt-1 truncate text-xs text-[#8B93A7]">{row.phone?.trim() || 'Sin teléfono registrado'}</p>
                  </div>
                  <StatusBadge label={status.label} tone={status.tone} />
                </div>

                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-3 border-y border-[#232632] py-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em] text-[#747E91]">Última compra</p>
                    <p className="mt-1 text-sm font-medium text-[#F5F7FB]">{dateLabel(row.last_purchase_on)}</p>
                    <p className="mt-0.5 text-[11px] text-[#AAB2C5]">{daysLabel(row)}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em] text-[#747E91]">Ritmo</p>
                    <p className="mt-1 text-sm font-medium text-[#F5F7FB]">{rhythmLabel(row)}</p>
                    <p className="mt-0.5 text-[11px] text-[#AAB2C5]">
                      {cadence === null ? 'Requiere al menos 2 compras' : `Basado en hasta ${cadenceWindow}`}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em] text-[#747E91]">Cierres</p>
                    <p className="mt-1 text-sm font-medium text-[#F5F7FB]">{numberValue(row.purchase_count).toLocaleString('es-VE')}</p>
                    <p className="mt-0.5 text-[11px] text-[#AAB2C5]">Compras registradas</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-[0.14em] text-[#747E91]">Facturación</p>
                    <p className="mt-1 text-sm font-medium text-[#F5F7FB]">{moneyFormatter.format(numberValue(row.net_revenue_usd))}</p>
                    <p className="mt-0.5 text-[11px] text-[#AAB2C5]">Total sin IVA</p>
                  </div>
                </div>

                <details className="group mt-2.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between py-1 text-xs font-semibold text-[#F7DA66]">
                    <span>Ver historial y señales</span>
                    <span aria-hidden="true" className="text-base transition group-open:rotate-45">+</span>
                  </summary>
                  <dl className="mt-2 grid grid-cols-2 gap-3 rounded-[14px] bg-[#0D1017] px-3 py-3 text-xs">
                    <div>
                      <dt className="text-[#747E91]">Primera compra</dt>
                      <dd className="mt-1 text-[#E2E6EF]">{dateLabel(row.first_purchase_on)}</dd>
                    </div>
                    <div>
                      <dt className="text-[#747E91]">Ticket promedio</dt>
                      <dd className="mt-1 text-[#E2E6EF]">{averageTicket === null ? 'Sin dato' : moneyFormatter.format(averageTicket)}</dd>
                    </div>
                    <div>
                      <dt className="text-[#747E91]">Último obsequio</dt>
                      <dd className="mt-1 text-[#E2E6EF]">{row.last_gift_on ? dateLabel(row.last_gift_on) : 'Sin obsequio registrado'}</dd>
                    </div>
                    <div>
                      <dt className="text-[#747E91]">Modalidad usada</dt>
                      <dd className="mt-1 text-[#E2E6EF]">{channelLabel(row)}</dd>
                    </div>
                    <div className="col-span-2">
                      <dt className="text-[#747E91]">Último asesor registrado en compra</dt>
                      <dd className="mt-1 text-[#E2E6EF]">{row.last_advisor_name_snapshot?.trim() || 'Sin asesor registrado'}</dd>
                    </div>
                  </dl>
                </details>

                <div className="mt-3">
                  {whatsappHref ? (
                    <a
                      href={whatsappHref}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex h-10 w-full items-center justify-center rounded-[13px] bg-[#1D6B42] px-4 text-sm font-semibold text-white"
                    >
                      Contactar por WhatsApp
                    </a>
                  ) : (
                    <div className="flex h-10 items-center justify-center rounded-[13px] border border-[#2A3040] text-xs text-[#747E91]">
                      Teléfono no disponible para WhatsApp
                    </div>
                  )}
                </div>
              </article>
            );
          })
        )}
      </section>

      {totalPages > 1 ? (
        <nav aria-label="Paginación de clientes" className="flex items-center justify-between gap-3 rounded-[18px] border border-[#232632] bg-[#12151D] px-3 py-2.5">
          {currentPage > 1 ? (
            <Link
              href={portfolioHref(routeState, { page: currentPage - 1 })}
              className="inline-flex h-9 items-center rounded-[12px] border border-[#2A3040] px-3 text-sm font-medium text-[#F5F7FB]"
            >
              Anterior
            </Link>
          ) : <span />}
          <span className="text-xs text-[#8B93A7]">Página {currentPage} de {totalPages}</span>
          {currentPage < totalPages ? (
            <Link
              href={portfolioHref(routeState, { page: currentPage + 1 })}
              className="inline-flex h-9 items-center rounded-[12px] border border-[#2A3040] px-3 text-sm font-medium text-[#F5F7FB]"
            >
              Siguiente
            </Link>
          ) : <span />}
        </nav>
      ) : null}
    </div>
  );
}
