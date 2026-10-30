'use client';

import type {
  CounterDailyHistoryCursor,
  CounterHistoricalSearchCursor,
  CounterHistoricalSearchResult,
} from './actions';

function moneyUsd(value: number) {
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function moneyBs(value: number) {
  return `Bs ${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatDateTime(value: string | null) {
  if (!value) return 'Sin hora';
  return new Date(value).toLocaleString('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  });
}

function historicalSearchStatusLabel(status: CounterHistoricalSearchResult['status']) {
  if (status === 'created') return 'Agendado / pendiente master';
  if (status === 'queued') return 'En cola de cocina';
  if (status === 'confirmed') return 'En cola de cocina';
  if (status === 'in_kitchen') return 'En preparación';
  if (status === 'ready') return 'Listo';
  if (status === 'out_for_delivery') return 'En camino';
  if (status === 'delivered') return 'Entregada';
  if (status === 'cancelled') return 'Cancelada';
  return status;
}

function historicalSearchReason(result: CounterHistoricalSearchResult) {
  if (result.status === 'created') return 'Master aún no lo ha enviado a cocina.';
  if (result.status === 'queued') return 'Ya está en la cola operativa de cocina.';
  if (result.status === 'confirmed') return 'Ya está enviado a cocina; falta que lo tomen.';
  if (result.status === 'in_kitchen') return 'Cocina lo está preparando.';
  if (result.status === 'ready') return 'Ya está listo para entrega.';
  if (result.status === 'out_for_delivery') return 'Ya fue entregado al motorizado.';
  if (result.status === 'delivered') return 'Esta orden ya fue entregada.';
  if (result.status === 'cancelled') return 'Esta orden fue cancelada.';
  return null;
}

function historicalSearchPaymentLabel(result: CounterHistoricalSearchResult) {
  if (result.pendingReportsCount > 0) return 'Pago por revisar';
  if (result.balanceUsd <= 0.005) return 'Pagado';
  if (result.confirmedPaidUsd > 0.005) return `Abonado · falta ${moneyUsd(result.balanceUsd)}`;
  return `Pendiente ${moneyUsd(result.balanceUsd)}`;
}

function CounterHistoryOrderList({
  results,
  nextPageAvailable,
  emptyMessage,
  isPending,
  loadMoreLabel,
  onLoadMore,
  onOpenOrder,
  onOpenPayment,
}: {
  results: CounterHistoricalSearchResult[];
  nextPageAvailable: boolean;
  emptyMessage: string;
  isPending: boolean;
  loadMoreLabel: string;
  onLoadMore: () => void;
  onOpenOrder: (orderId: number) => void;
  onOpenPayment: (orderId: number) => void;
}) {
  if (results.length === 0) {
    return (
      <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
        {emptyMessage}
      </div>
    );
  }

  return (
    <>
      <div className="grid gap-2 xl:grid-cols-2">
        {results.map((result) => {
          const reason = historicalSearchReason(result);

          return (
            <div key={result.id} className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-base font-semibold">#{result.displayNumber}</span>
                    <span className="rounded-full border border-[#303044] px-2 py-0.5 text-xs text-[#C7C8D1]">
                      {result.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}
                    </span>
                    <span className="rounded-full border border-[#FEEF00]/50 bg-[#FEEF00]/10 px-2 py-0.5 text-xs font-semibold text-[#FEEF00]">
                      {historicalSearchStatusLabel(result.status)}
                    </span>
                  </div>
                  <div className="mt-1 truncate text-sm font-semibold">{result.clientName}</div>
                  <div className="mt-1 text-xs text-[#9FA0AA]">
                    {result.clientPhone || 'Sin teléfono'} · {result.scheduledDate || 'Sin fecha'}{' '}
                    {result.scheduledTime || ''}
                  </div>
                  {result.receiverName || result.receiverPhone ? (
                    <div className="mt-1 text-xs text-[#9FA0AA]">
                      Recibe: {result.receiverName || 'Sin nombre'}
                      {result.receiverPhone ? ` · ${result.receiverPhone}` : ''}
                    </div>
                  ) : null}
                  {reason ? <div className="mt-2 text-sm text-[#C7C8D1]">{reason}</div> : null}
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-sm font-semibold">{moneyUsd(result.totalUsd)}</div>
                  <div className="text-xs text-[#9FA0AA]">{moneyBs(result.totalBs)}</div>
                </div>
              </div>

              <div className="mt-3 grid gap-2 rounded-[8px] border border-[#242433] bg-[#111118] p-2 text-xs text-[#C7C8D1] sm:grid-cols-2">
                <div>
                  <span className="text-[#777988]">Productos: </span>
                  {result.productSummary.length > 0
                    ? result.productSummary.join(', ')
                    : `${result.itemCount} item(s)`}
                </div>
                <div>
                  <span className="text-[#777988]">Pago: </span>
                  {historicalSearchPaymentLabel(result)}
                </div>
                <div>
                  <span className="text-[#777988]">Creada: </span>
                  {formatDateTime(result.createdAt)}
                </div>
                <div>
                  <span className="text-[#777988]">Entrega: </span>
                  {result.deliveredAt
                    ? formatDateTime(result.deliveredAt)
                    : result.readyAt
                      ? `Lista ${formatDateTime(result.readyAt)}`
                      : 'Pendiente'}
                </div>
              </div>

              {result.note ? <div className="mt-2 text-xs text-[#9FA0AA]">Nota: {result.note}</div> : null}

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => onOpenOrder(result.id)}
                  disabled={isPending}
                  className="rounded-[8px] border border-[#303044] bg-[#111118] px-3 py-2 text-xs font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/60 disabled:opacity-60"
                >
                  Abrir expediente
                </button>
                {result.status !== 'cancelled' && result.balanceUsd > 0.005 ? (
                  <button
                    type="button"
                    onClick={() => onOpenPayment(result.id)}
                    disabled={isPending}
                    className="rounded-[8px] border border-emerald-300/40 bg-emerald-300/10 px-3 py-2 text-xs font-semibold text-emerald-100 hover:border-emerald-300/70 disabled:opacity-60"
                  >
                    Abrir cobro
                  </button>
                ) : (
                  <div className="rounded-[8px] border border-[#242433] px-3 py-2 text-center text-xs text-[#777988]">
                    {result.status === 'cancelled' ? 'Solo consulta' : 'Sin deuda pendiente'}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {nextPageAvailable ? (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isPending}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:cursor-wait disabled:opacity-60"
          >
            {isPending ? 'Cargando...' : loadMoreLabel}
          </button>
        </div>
      ) : null}
    </>
  );
}

export function CounterDailyHistoryPanel({
  results,
  nextCursor,
  loaded,
  isPending,
  selectedOrderId,
  onRefresh,
  onLoadMore,
  onSelectOrder,
}: {
  results: CounterHistoricalSearchResult[];
  nextCursor: CounterDailyHistoryCursor | null;
  loaded: boolean;
  isPending: boolean;
  selectedOrderId: number | null;
  onRefresh: () => void;
  onLoadMore: () => void;
  onSelectOrder: (orderId: number) => void;
}) {
  return (
    <section className="min-w-0 rounded-[8px] border border-[#242433] bg-[#111118] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Entregados hoy</h2>
          <p className="mt-1 text-xs text-[#9FA0AA]">
            Pickup y delivery completados durante el día operativo de Caracas. Se carga solo al abrir.
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={isPending}
          className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:opacity-60"
        >
          {isPending ? 'Actualizando...' : 'Actualizar'}
        </button>
      </div>

      {loaded ? (
        <div className="mt-3 text-right text-xs text-[#9FA0AA]">
          {results.length} entrega(s) cargada(s)
        </div>
      ) : null}

      <div className="mt-3">
        {!loaded && isPending ? (
          <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
            Cargando entregas de hoy...
          </div>
        ) : results.length === 0 ? (
          <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
            Todavía no hay pedidos entregados hoy.
          </div>
        ) : (
          <div className="max-h-[calc(100vh-330px)] space-y-2 overflow-y-auto pr-1">
            {results.map((result) => (
              <button
                key={result.id}
                type="button"
                onClick={() => onSelectOrder(result.id)}
                aria-pressed={selectedOrderId === result.id}
                className={[
                  'w-full rounded-[8px] border p-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                  selectedOrderId === result.id
                    ? 'border-[#FEEF00] bg-[#FEEF00]/8'
                    : 'border-[#303044] bg-[#0B0B0D] hover:border-[#FEEF00]/45',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-[#FEEF00]">#{result.displayNumber}</span>
                      <span className="rounded-full border border-[#303044] px-2 py-0.5 text-[11px] text-[#C7C8D1]">
                        {result.fulfillment === 'delivery' ? 'Delivery' : 'Pickup'}
                      </span>
                    </div>
                    <div className="mt-1 truncate text-sm font-semibold text-[#F5F5F7]">
                      {result.clientName}
                    </div>
                    <div className="mt-1 text-xs text-[#9FA0AA]">
                      Entregada {formatDateTime(result.deliveredAt)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-semibold text-[#F5F5F7]">{moneyUsd(result.totalUsd)}</div>
                    <div className={[
                      'mt-1 text-xs font-semibold',
                      result.balanceUsd > 0.005 || result.pendingReportsCount > 0
                        ? 'text-orange-200'
                        : 'text-emerald-200',
                    ].join(' ')}>
                      {historicalSearchPaymentLabel(result)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 truncate text-xs text-[#C7C8D1]">
                  {result.productSummary.length > 0
                    ? result.productSummary.join(', ')
                    : `${result.itemCount} item(s)`}
                </div>
              </button>
            ))}

            {nextCursor ? (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isPending}
                className="min-h-11 w-full rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:opacity-60"
              >
                {isPending ? 'Cargando...' : 'Cargar entregas anteriores'}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

export function CounterHistoricalSearchPanel({
  query,
  results,
  nextCursor,
  searched,
  isPending,
  onQueryChange,
  onSearch,
  onLoadMore,
  onClear,
  onOpenOrder,
  onOpenPayment,
}: {
  query: string;
  results: CounterHistoricalSearchResult[];
  nextCursor: CounterHistoricalSearchCursor | null;
  searched: boolean;
  isPending: boolean;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onLoadMore: () => void;
  onClear: () => void;
  onOpenOrder: (orderId: number) => void;
  onOpenPayment: (orderId: number) => void;
}) {
  return (
    <section className="mt-4 rounded-[8px] border border-[#242433] bg-[#111118] p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Buscar orden</h2>
          <p className="mt-1 text-xs text-[#9FA0AA]">
            Consulta por número, cliente o teléfono cuando una orden no aparezca en la cola.
          </p>
        </div>
        {searched ? (
          <button
            type="button"
            onClick={onClear}
            className="rounded-full border border-[#303044] bg-[#0B0B0D] px-3 py-1.5 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50"
          >
            Limpiar
          </button>
        ) : null}
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-[1fr_128px]">
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSearch();
          }}
          placeholder="Orden, cliente o teléfono"
          className="rounded-[8px] border border-[#303044] bg-[#0B0B0D] px-3 py-2 text-sm outline-none placeholder:text-[#666878] focus:border-[#FEEF00]/70"
        />
        <button
          type="button"
          onClick={onSearch}
          disabled={isPending}
          className="rounded-[8px] border border-[#FEEF00]/70 bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#fff45c] disabled:cursor-wait disabled:opacity-60"
        >
          {isPending ? 'Buscando...' : 'Buscar'}
        </button>
      </div>

      {searched ? (
        <div className="mt-4">
          <CounterHistoryOrderList
            results={results}
            nextPageAvailable={Boolean(nextCursor)}
            emptyMessage="Sin resultados para esa búsqueda."
            isPending={isPending}
            loadMoreLabel="Cargar resultados anteriores"
            onLoadMore={onLoadMore}
            onOpenOrder={onOpenOrder}
            onOpenPayment={onOpenPayment}
          />
        </div>
      ) : null}
    </section>
  );
}
