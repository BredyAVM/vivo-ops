'use client';

import type {
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
            Consulta cualquier orden por numero, cliente o telefono cuando no aparezca en la cola del counter.
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
          placeholder="Orden, cliente o telefono"
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
          {results.length === 0 ? (
            <div className="rounded-[8px] border border-dashed border-[#303044] p-4 text-sm text-[#9FA0AA]">
              Sin resultados para esa busqueda.
            </div>
          ) : (
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
                          {result.clientPhone || 'Sin telefono'} - {result.scheduledDate || 'Sin fecha'}{' '}
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
          )}
          {nextCursor ? (
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                onClick={onLoadMore}
                disabled={isPending}
                className="rounded-full border border-[#303044] bg-[#0B0B0D] px-4 py-2 text-sm font-semibold text-[#F5F5F7] hover:border-[#FEEF00]/50 disabled:cursor-wait disabled:opacity-60"
              >
                {isPending ? 'Cargando...' : 'Cargar resultados anteriores'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
