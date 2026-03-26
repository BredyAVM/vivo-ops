// src/app/app/advisor/pedidos/page.tsx
'use client';

import React, { useMemo, useState } from 'react';

type OrderStatus =
  | 'created'
  | 'queued'
  | 'confirmed'
  | 'in_kitchen'
  | 'ready'
  | 'out_for_delivery'
  | 'delivered'
  | 'cancelled';

type Fulfillment = 'pickup' | 'delivery';
type PaymentVerify = 'none' | 'pending' | 'confirmed' | 'rejected';

type OrderLine = {
  name: string;
  qty: number;
  unitsPerService: number; // 0 si no aplica
  priceBs: number;
  isDelivery?: boolean;
  editableDetailLines?: string[];
};

type AdvisorOrder = {
  id: number;
  createdAtISO: string; // hora pedido
  deliveryAtISO: string; // fecha/hora entrega

  clientName: string;
  fulfillment: Fulfillment;

  status: OrderStatus;
  queuedNeedsReapproval: boolean;

  totalUsd: number;
  balanceUsd: number;
  totalBs: number;

  paymentVerify: PaymentVerify;

  notes?: string;
  hasNoteOrDetail: boolean;

  lines: OrderLine[];
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Pendiente de aprobación',
  queued: 'En cola',
  confirmed: 'Enviado a cocina',
  in_kitchen: 'En preparación',
  ready: 'Preparada',
  out_for_delivery: 'En camino',
  delivered: 'Entregado / Retirado',
  cancelled: 'Cancelado',
};

const pillLabel = (f: Fulfillment) => (f === 'delivery' ? 'Delivery' : 'Pickup');

const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

// Bs formato A: Bs 23.220
const fmtBs = (n: number) => {
  const s = Math.round(n).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const idxFromEnd = s.length - i;
    out += s[i];
    if (idxFromEnd > 1 && idxFromEnd % 3 === 1) out += '.';
  }
  return `Bs ${out}`;
};

const fmtTimeOnly = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
};

// "Mié 04/03 · 9:05 AM"
const fmtDowDateTime = (iso: string) => {
  const d = new Date(iso);
  const dow = d.toLocaleDateString('es-VE', { weekday: 'short' }); // "mié"
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true });
  const cap = dow.charAt(0).toUpperCase() + dow.slice(1);
  return `${cap} ${dd}/${mm} · ${time}`;
};

const paymentLabel = (balanceUsd: number) => (balanceUsd <= 0 ? 'Pagado ✅' : `● Pendiente: ${fmtUSD(balanceUsd)}`);
const paymentToneClass = (balanceUsd: number) => (balanceUsd <= 0 ? 'text-emerald-400' : 'text-orange-500');

// ---- Preview ordering: Servicios -> Extras -> Delivery ----
function orderMainLinesForPreview(lines: OrderLine[]) {
  const services: OrderLine[] = [];
  const extras: OrderLine[] = [];
  const delivery: OrderLine[] = [];

  for (const l of lines) {
    const isDelivery = !!l.isDelivery || l.name.toLowerCase().startsWith('delivery');
    if (isDelivery) {
      delivery.push(l);
      continue;
    }

    const nameLower = l.name.toLowerCase();
    const isExtra =
      nameLower.includes('salsa') ||
      nameLower.includes('aderezo') ||
      nameLower.includes('crema') ||
      nameLower.includes('pepsi') ||
      nameLower.includes('coca') ||
      nameLower.includes('malta') ||
      nameLower.includes('lipton') ||
      nameLower.includes('yukery') ||
      nameLower.includes('jugo') ||
      nameLower.includes('dondy');

    (isExtra ? extras : services).push(l);
  }

  return [...services, ...extras, ...delivery];
}

function calcUnits(line: OrderLine) {
  if (line.unitsPerService > 0) return line.qty * line.unitsPerService;

  const m = line.name.match(/\((\d+)\s*und\)/i);
  if (m) {
    const base = Number(m[1]);
    if (!Number.isNaN(base) && base > 0) return line.qty * base;
  }
  return null;
}

function lineTextWhatsAppStyle(line: OrderLine) {
  const units = calcUnits(line);
  const bs = fmtBs(line.qty * line.priceBs);
  const isDelivery = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');

  if (isDelivery) return `▪️ ${line.qty} ${line.name}: ${bs}`;

  if (units !== null) {
    const cleanName = line.name.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    return `▪️ ${line.qty} Serv. ${cleanName} (${units} und): ${bs}`;
  }

  return `▪️ ${line.qty} ${line.name}: ${bs}`;
}

// ---- Time modes ----
type TimeMode = 'today' | 'week' | 'range';
type ViewMode = 'time' | 'pending_anytime';

// ---- Filters ----
type PayFilter = 'all' | 'pending_balance' | 'paid' | 'verify_pending' | 'verify_rejected';
type ProcFilter =
  | 'all'
  | 'created'
  | 'queued'
  | 'confirmed'
  | 'in_kitchen'
  | 'ready'
  | 'out_for_delivery'
  | 'finalized'
  | 'reapproval';
type ApprFilter = 'all' | 'to_approve' | 'reapprove' | 'approved';

function isFinalized(s: OrderStatus) {
  return s === 'delivered' || s === 'cancelled';
}

function payPass(o: AdvisorOrder, f: PayFilter) {
  if (f === 'all') return true;
  if (f === 'pending_balance') return o.balanceUsd > 0;
  if (f === 'paid') return o.balanceUsd <= 0; // ✅ por redondeos
  if (f === 'verify_pending') return o.paymentVerify === 'pending';
  if (f === 'verify_rejected') return o.paymentVerify === 'rejected';
  return true;
}

function procPass(o: AdvisorOrder, f: ProcFilter) {
  if (f === 'all') return true;
  if (f === 'finalized') return isFinalized(o.status);
  if (f === 'reapproval') return o.status === 'queued' && o.queuedNeedsReapproval;
  return o.status === f;
}

function apprPass(o: AdvisorOrder, f: ApprFilter) {
  if (f === 'all') return true;
  if (f === 'to_approve') return o.status === 'created';
  if (f === 'reapprove') return o.status === 'queued' && o.queuedNeedsReapproval;
  if (f === 'approved') return o.status !== 'created' && !(o.status === 'queued' && o.queuedNeedsReapproval);
  return true;
}

// ---- date helpers ----
function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function startOfWeekMon(d: Date) {
  const day = d.getDay(); // Sun=0
  const diff = (day === 0 ? -6 : 1) - day;
  const x = new Date(d);
  x.setDate(d.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfWeekSun(d: Date) {
  const start = startOfWeekMon(d);
  const x = new Date(start);
  x.setDate(start.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x;
}

function inRange(d: Date, a: Date, b: Date) {
  return d >= a && d <= b;
}

export default function AdvisorPedidosPage() {
  // View modes
  const [viewMode, setViewMode] = useState<ViewMode>('time');
  const [timeMode, setTimeMode] = useState<TimeMode>('today');

  // Range selection (demo)
  const [rangeStart] = useState<Date>(() => {
    const d = new Date();
    d.setDate(d.getDate() - 3);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [rangeEnd] = useState<Date>(() => {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d;
  });

  // Filters
  const [payFilter, setPayFilter] = useState<PayFilter>('all');
  const [procFilter, setProcFilter] = useState<ProcFilter>('all');
  const [apprFilter, setApprFilter] = useState<ApprFilter>('all');

  // Dropdown states
  const [openPay, setOpenPay] = useState(false);
  const [openProc, setOpenProc] = useState(false);
  const [openAppr, setOpenAppr] = useState(false);

  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Mock data
  const orders: AdvisorOrder[] = useMemo(() => {
    const mkCreated = (minsAgo: number) => new Date(Date.now() - minsAgo * 60 * 1000).toISOString();
    const mkDelivery = (dayOffset: number, hour: number, minute: number) => {
      const d = new Date();
      d.setDate(d.getDate() + dayOffset);
      d.setHours(hour, minute, 0, 0);
      return d.toISOString();
    };

    return [
      {
        id: 10510,
        createdAtISO: mkCreated(55),
        deliveryAtISO: mkDelivery(0, 11, 30),
        clientName: 'María del Carmen Pérez González',
        fulfillment: 'pickup',
        status: 'queued',
        queuedNeedsReapproval: true,
        totalUsd: 16.0,
        balanceUsd: 0,
        totalBs: 8640,
        paymentVerify: 'confirmed',
        notes: 'Facturar a nombre de: Inversiones ABC.',
        hasNoteOrDetail: true,
        lines: [
          {
            name: 'Combo Baby Mix Frito (25 und)',
            qty: 1,
            unitsPerService: 0,
            priceBs: 5940,
            editableDetailLines: ['10 Mini Tequeños.', '5 Empanadas.', '5 Cachitas', '5 Bombys.'],
          },
          { name: 'Salsa Tártara 5oz', qty: 1, unitsPerService: 0, priceBs: 1080 },
          { name: 'Pepsi 1,5 Lts', qty: 1, unitsPerService: 0, priceBs: 1080 },
        ],
      },
      {
        id: 10522,
        createdAtISO: mkCreated(35),
        deliveryAtISO: mkDelivery(0, 13, 0),
        clientName: 'Ana Rodríguez',
        fulfillment: 'delivery',
        status: 'queued',
        queuedNeedsReapproval: false,
        totalUsd: 30,
        balanceUsd: 30,
        totalBs: 16200,
        paymentVerify: 'pending',
        notes: '',
        hasNoteOrDetail: false,
        lines: [
          { name: 'Combo Rumba Mix Frito (76 und)', qty: 1, unitsPerService: 0, priceBs: 16200 },
          { name: 'Delivery Zona 1', qty: 1, unitsPerService: 0, priceBs: 1080, isDelivery: true },
        ],
      },
      {
        id: 10555,
        createdAtISO: mkCreated(240),
        deliveryAtISO: mkDelivery(0, 10, 0),
        clientName: 'Rafael Méndez',
        fulfillment: 'delivery',
        status: 'out_for_delivery',
        queuedNeedsReapproval: false,
        totalUsd: 11,
        balanceUsd: -0.01, // ejemplo de redondeo
        totalBs: 5940,
        paymentVerify: 'confirmed',
        notes: '',
        hasNoteOrDetail: false,
        lines: [
          { name: 'Combo Baby Mix Frito (25 und)', qty: 1, unitsPerService: 0, priceBs: 5940 },
          { name: 'Delivery Zona 1', qty: 1, unitsPerService: 0, priceBs: 1080, isDelivery: true },
        ],
      },
      {
        id: 10401,
        createdAtISO: mkCreated(9999),
        deliveryAtISO: mkDelivery(-28, 9, 0), // hace ~1 mes
        clientName: 'Cliente Viejo Pendiente',
        fulfillment: 'delivery',
        status: 'delivered',
        queuedNeedsReapproval: false,
        totalUsd: 20,
        balanceUsd: 10, // pendiente vieja (para probar “Pendientes”)
        totalBs: 10800,
        paymentVerify: 'none',
        notes: 'Pendiente de cobro desde hace tiempo.',
        hasNoteOrDetail: true,
        lines: [
          { name: 'Combo Sexy Mix Frito (50 und)', qty: 1, unitsPerService: 0, priceBs: 10800 },
          { name: 'Delivery Zona 3', qty: 1, unitsPerService: 0, priceBs: 2160, isDelivery: true },
        ],
      },
    ];
  }, []);

  const now = new Date();

  // Base list based on viewMode/timeMode (PERÍODO del botón Hoy/Semana/Rango o Pendientes)
  const basePeriod = useMemo(() => {
    if (viewMode === 'pending_anytime') {
      // ✅ Pendientes: balance>0 OR verify pending OR not finalized
      return orders.filter((o) => o.balanceUsd > 0 || o.paymentVerify === 'pending' || !isFinalized(o.status));
    }

    if (timeMode === 'today') {
      return orders.filter((o) => isSameDay(new Date(o.deliveryAtISO), now));
    }

    if (timeMode === 'week') {
      const a = startOfWeekMon(now);
      const b = endOfWeekSun(now);
      return orders.filter((o) => inRange(new Date(o.deliveryAtISO), a, b));
    }

    // range
    return orders.filter((o) => inRange(new Date(o.deliveryAtISO), rangeStart, rangeEnd));
  }, [orders, viewMode, timeMode, now, rangeStart, rangeEnd]);

  // Apply filters to show list
  const filtered = useMemo(() => {
    return basePeriod
      .filter((o) => payPass(o, payFilter))
      .filter((o) => procPass(o, procFilter))
      .filter((o) => apprPass(o, apprFilter))
      .slice()
      .sort((a, b) => new Date(a.createdAtISO).getTime() - new Date(b.createdAtISO).getTime());
  }, [basePeriod, payFilter, procFilter, apprFilter]);

  // KPI card (como tu imagen): basado en el período (NO depende de filtros de pago/proceso)
  const periodTotalCount = basePeriod.length;
  const periodClosesCount = useMemo(() => basePeriod.filter((o) => isFinalized(o.status)).length, [basePeriod]);

  // Total facturado del período (USD)
  const periodBilledUsd = useMemo(() => basePeriod.reduce((s, o) => s + o.totalUsd, 0), [basePeriod]);

  // Cobrado CONFIRMADO: solo órdenes con paymentVerify === 'confirmed'
  const periodCollectedConfirmedUsd = useMemo(
    () => basePeriod.reduce((s, o) => s + (o.paymentVerify === 'confirmed' ? o.totalUsd : 0), 0),
    [basePeriod]
  );

  const fmtUSDCompact = (n: number) => `${Math.round(n)}$`;

  // Decide time label + time format
  const showFullDateTime = useMemo(() => {
    if (viewMode === 'pending_anytime') return true;
    if (timeMode === 'today') return false;
    return true; // week or range
  }, [viewMode, timeMode]);

  const dateButtonDisabled = viewMode === 'pending_anytime';

  const timeLabel = useMemo(() => {
    if (timeMode === 'today') return 'Hoy ▾';
    if (timeMode === 'week') return 'Esta semana ▾';
    return 'Rango ▾';
  }, [timeMode]);

  const closeAllDropdowns = () => {
    setOpenPay(false);
    setOpenProc(false);
    setOpenAppr(false);
  };

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]" onClick={() => closeAllDropdowns()}>
      {/* Sticky Header */}
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-md px-4 pt-4 pb-3">
          {/* Top row: menu/back + title + create */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  alert('Abrir menú (demo)');
                }}
                title="Menú"
              >
                ☰
              </button>

              <button
                className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  alert('Volver (demo)');
                }}
                title="Atrás"
              >
                ←
              </button>

              <h1 className="ml-1 text-lg font-semibold">Pedidos</h1>
            </div>

            <button
              className="rounded-xl bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-[#0B0B0D]"
              onClick={(e) => {
                e.stopPropagation();
                alert('Crear pedido (demo)');
              }}
            >
              Crear
            </button>
          </div>

          {/* Row: Time button (left) + KPI mini card (center) + Pendientes (right) */}
          <div className="mt-3 flex items-stretch gap-2">
            {/* Time */}
            <button
              className={[
                'flex-1 rounded-2xl border px-3 py-2 text-left',
                dateButtonDisabled
                  ? 'border-[#242433] bg-[#121218] text-[#8A8A96]'
                  : 'border-[#242433] bg-[#121218] text-[#F5F5F7]',
              ].join(' ')}
              disabled={dateButtonDisabled}
              onClick={(e) => {
                e.stopPropagation();
                if (dateButtonDisabled) return;
                // Demo cycle: today -> week -> range -> today
                setTimeMode((m) => (m === 'today' ? 'week' : m === 'week' ? 'range' : 'today'));
                setViewMode('time');
              }}
              title="Seleccionar período"
            >
              <div className="text-sm font-medium">{timeLabel}</div>
              <div className="mt-1 text-xs text-[#B7B7C2]">
                {dateButtonDisabled
                  ? 'Bloqueado por Pendientes'
                  : timeMode === 'today'
                  ? 'Solo hoy'
                  : timeMode === 'week'
                  ? 'Semana actual'
                  : 'Rango seleccionado'}
              </div>
            </button>

            {/* KPI mini card */}
            <div className="w-[170px] rounded-2xl border border-[#242433] bg-[#121218] px-3 py-2">
              <div className="text-xs text-[#B7B7C2]">
                Facturación{' '}
                <span className="text-[#F5F5F7]">
                  {fmtUSDCompact(periodCollectedConfirmedUsd)}/{fmtUSDCompact(periodBilledUsd)}
                </span>
              </div>

              <div className="mt-1 text-xs text-[#B7B7C2]">
                Cierre{' '}
                <span className="text-[#F5F5F7]">
                  {periodClosesCount}/{periodTotalCount}
                </span>
              </div>
            </div>

            {/* Pendientes */}
            <button
              className={[
                'w-[120px] rounded-2xl border px-3 py-2 text-sm font-semibold',
                viewMode === 'pending_anytime'
                  ? 'border-[#FEEF00] bg-[#121218] text-[#F5F5F7]'
                  : 'border-[#242433] bg-[#121218] text-[#B7B7C2]',
              ].join(' ')}
              onClick={(e) => {
                e.stopPropagation();
                setViewMode((v) => (v === 'pending_anytime' ? 'time' : 'pending_anytime'));
              }}
              title="Pendientes de cualquier fecha"
            >
              Pendientes
            </button>
          </div>

          {/* Filter row: Todos + Pago + Proceso + Aprobación */}
          <div className="mt-3 flex gap-2">
            <button
              className="rounded-full border border-[#242433] bg-[#121218] px-3 py-1.5 text-sm text-[#B7B7C2]"
              onClick={(e) => {
                e.stopPropagation();
                setPayFilter('all');
                setProcFilter('all');
                setApprFilter('all');
              }}
            >
              Todos
            </button>

            <DropdownButton
              label="Pago"
              open={openPay}
              onToggle={(e) => {
                e.stopPropagation();
                setOpenPay((v) => !v);
                setOpenProc(false);
                setOpenAppr(false);
              }}
            />
            <DropdownButton
              label="Proceso"
              open={openProc}
              onToggle={(e) => {
                e.stopPropagation();
                setOpenProc((v) => !v);
                setOpenPay(false);
                setOpenAppr(false);
              }}
            />
            <DropdownButton
              label="Aprobación"
              open={openAppr}
              onToggle={(e) => {
                e.stopPropagation();
                setOpenAppr((v) => !v);
                setOpenPay(false);
                setOpenProc(false);
              }}
            />
          </div>

          {/* Dropdown menus */}
          {openPay ? (
            <Menu>
              <MenuItem onClick={() => setPayFilter('all')}>Todos</MenuItem>
              <MenuItem onClick={() => setPayFilter('pending_balance')}>Pendiente</MenuItem>
              <MenuItem onClick={() => setPayFilter('paid')}>Pagado</MenuItem>
              <MenuItem onClick={() => setPayFilter('verify_pending')}>Por confirmar</MenuItem>
              <MenuItem onClick={() => setPayFilter('verify_rejected')}>Rechazado</MenuItem>
            </Menu>
          ) : null}

          {openProc ? (
            <Menu>
              <MenuItem onClick={() => setProcFilter('all')}>Todos</MenuItem>
              <MenuItem onClick={() => setProcFilter('created')}>Pendiente (aprobación)</MenuItem>
              <MenuItem onClick={() => setProcFilter('queued')}>En cola</MenuItem>
              <MenuItem onClick={() => setProcFilter('confirmed')}>Enviado a cocina</MenuItem>
              <MenuItem onClick={() => setProcFilter('in_kitchen')}>En preparación</MenuItem>
              <MenuItem onClick={() => setProcFilter('ready')}>Preparada</MenuItem>
              <MenuItem onClick={() => setProcFilter('out_for_delivery')}>En camino</MenuItem>
              <MenuItem onClick={() => setProcFilter('reapproval')}>Re-aprobación</MenuItem>
              <MenuItem onClick={() => setProcFilter('finalized')}>Finalizadas</MenuItem>
            </Menu>
          ) : null}

          {openAppr ? (
            <Menu>
              <MenuItem onClick={() => setApprFilter('all')}>Todos</MenuItem>
              <MenuItem onClick={() => setApprFilter('to_approve')}>Por aprobar</MenuItem>
              <MenuItem onClick={() => setApprFilter('reapprove')}>Re-aprobar</MenuItem>
              <MenuItem onClick={() => setApprFilter('approved')}>Aprobadas</MenuItem>
            </Menu>
          ) : null}
        </div>
      </div>

      {/* List */}
      <div className="mx-auto max-w-md px-4 py-4">
        <div className="space-y-3">
          {filtered.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              expanded={expandedId === o.id}
              showFullDateTime={showFullDateTime}
              onToggle={() => setExpandedId((id) => (id === o.id ? null : o.id))}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function DropdownButton({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: (e: React.MouseEvent) => void;
}) {
  return (
    <button
      className={[
        'rounded-full border bg-[#121218] px-3 py-1.5 text-sm',
        open ? 'border-[#FEEF00] text-[#F5F5F7]' : 'border-[#242433] text-[#B7B7C2]',
      ].join(' ')}
      onClick={onToggle}
    >
      {label} ▾
    </button>
  );
}

function Menu({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2 overflow-hidden rounded-2xl border border-[#242433] bg-[#121218]">
      {children}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className="w-full px-4 py-3 text-left text-sm text-[#F5F5F7] hover:bg-[#191926]"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function OrderCard({
  order,
  expanded,
  onToggle,
  showFullDateTime,
}: {
  order: AdvisorOrder;
  expanded: boolean;
  onToggle: () => void;
  showFullDateTime: boolean;
}) {
  const statusLabel = ORDER_STATUS_LABEL[order.status];
  const needsReapproval = order.status === 'queued' && order.queuedNeedsReapproval;

  // En Hoy: hora del pedido. En Semana/Rango/Pendientes: día + fecha + hora (de entrega)
  const timeText = showFullDateTime ? fmtDowDateTime(order.deliveryAtISO) : fmtTimeOnly(order.createdAtISO);

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#121218] shadow-sm">
      <button onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{order.clientName}</div>

            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[#B7B7C2]">
              <span>{order.id}</span>
              {order.hasNoteOrDetail ? <span title="Tiene detalle/nota">📝</span> : null}
              {needsReapproval ? (
                <span className="rounded-full bg-orange-500 px-2 py-0.5 text-[11px] font-semibold text-[#0B0B0D]">
                  Re-aprobación
                </span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="text-xs font-medium text-[#F5F5F7]">{timeText}</div>
            <span className="rounded-full border border-[#242433] bg-[#191926] px-2 py-0.5 text-xs text-[#F5F5F7]">
              {pillLabel(order.fulfillment)}
            </span>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between gap-3">
          <div className="text-sm">
            <span className="text-[#B7B7C2]">Total: </span>
            <span className="font-semibold">{fmtUSD(order.totalUsd)}</span>
            <span className="text-[#B7B7C2]"> · </span>
            <span className={['font-medium', paymentToneClass(order.balanceUsd)].join(' ')}>
              {paymentLabel(order.balanceUsd)}
            </span>
          </div>

          <div className="text-[#B7B7C2]">{expanded ? '˄' : '˅'}</div>
        </div>

        <div className="mt-2 text-sm text-[#F5F5F7]">{statusLabel}</div>
      </button>

      {expanded ? (
        <div className="border-t border-[#242433] px-4 py-3">
          <div className="text-sm font-semibold">Pedido:</div>

          <div className="mt-2 space-y-2 text-sm">
            <PreviewLines order={order} />
          </div>

          <div className="mt-3 text-sm font-semibold">
            TOTAL: {fmtBs(order.totalBs)} / {fmtUSD(order.totalUsd)}
          </div>

          <div className="mt-3">
            <button
              className="w-full rounded-2xl border border-[#242433] bg-[#191926] px-4 py-2 text-sm text-[#F5F5F7]"
              onClick={(e) => {
                e.stopPropagation();
                alert('Abrir detalle (demo) — aquí va Modificar/Cargar pago según estado');
              }}
            >
              Ver ›
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PreviewLines({ order }: { order: AdvisorOrder }) {
  const ordered = orderMainLinesForPreview(order.lines);
  const main = ordered.slice(0, 3);
  const restCount = Math.max(0, ordered.length - main.length);

  return (
    <>
      {main.map((line, idx) => {
        const mainText = lineTextWhatsAppStyle(line);
        return (
          <div key={idx} className="leading-5">
            <div className="text-[#F5F5F7]">{mainText}</div>

            {line.editableDetailLines && line.editableDetailLines.length > 0 ? (
              <div className="mt-1 space-y-1 pl-4 text-[#B7B7C2]">
                {line.editableDetailLines.slice(0, 4).map((t, i) => (
                  <div key={i}>* {t}</div>
                ))}
                {line.editableDetailLines.length > 4 ? (
                  <div className="text-[#8A8A96]">+ {line.editableDetailLines.length - 4} líneas…</div>
                ) : null}
              </div>
            ) : null}

            {idx === 0 && order.notes?.trim() ? (
              <div className="mt-1 text-[#8A8A96] truncate">Nota: “{order.notes}”</div>
            ) : null}
          </div>
        );
      })}

      {restCount > 0 ? <div className="text-[#8A8A96]">+ {restCount} más…</div> : null}
    </>
  );
}