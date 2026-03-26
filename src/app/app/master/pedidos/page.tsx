// src/app/app/master/pedidos/page.tsx
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

type RoleView = 'master' | 'advisor';

type OrderLine = {
  name: string;
  qty: number;
  unitsPerService: number; // 0 si no aplica
  priceBs: number; // precio unitario en Bs
  isDelivery?: boolean; // para forzar delivery al final
  editableDetailLines?: string[]; // líneas tipo "* 10 Mini Tequeños."
};

type OrderListItem = {
  id: number;
  orderNumber: string;
  createdAtISO: string;

  clientName: string;
  fulfillment: Fulfillment;

  totalUsd: number;
  balanceUsd: number;

  status: OrderStatus;

  // Master
  advisorName?: string;

  // Indicadores
  hasNoteOrDetail: boolean;

  // Preview (expanded)
  lines: OrderLine[];
  totalBs: number;
};

const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  created: 'Creada',
  queued: 'En cola',
  confirmed: 'Enviado a cocina',
  in_kitchen: 'En preparación',
  ready: 'Preparada',
  out_for_delivery: 'En camino',
  delivered: 'Entregado / Retirado',
  cancelled: 'Cancelado',
};

type MacroFilter = 'all' | 'pending' | 'in_progress' | 'done';

function matchesMacroFilter(o: OrderListItem, f: MacroFilter) {
  if (f === 'all') return true;
  if (f === 'pending') return o.balanceUsd > 0;
  if (f === 'in_progress') {
    return ['confirmed', 'in_kitchen', 'ready', 'out_for_delivery'].includes(o.status);
  }
  return ['delivered', 'cancelled'].includes(o.status);
}

const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

// Formato A: Bs 23.220 (miles con punto, sin decimales)
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

// ✅ Hora en AM/PM
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
};

const pillLabel = (f: Fulfillment) => (f === 'delivery' ? 'Delivery' : 'Pickup');

const paymentLabel = (balanceUsd: number) => {
  if (balanceUsd <= 0) return 'Pagado ✅';
  return `● Pendiente: ${fmtUSD(balanceUsd)}`;
};

const paymentToneClass = (balanceUsd: number) =>
  balanceUsd <= 0 ? 'text-emerald-400' : 'text-orange-500';

// --- Preview ordering helpers (Servicios -> Extras -> Delivery) ---
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
  // 1) unitsPerService > 0 => qty * unitsPerService
  if (line.unitsPerService > 0) return line.qty * line.unitsPerService;

  // 2) name trae "(X und)" => qty * X
  const m = line.name.match(/\((\d+)\s*und\)/i);
  if (m) {
    const base = Number(m[1]);
    if (!Number.isNaN(base) && base > 0) return line.qty * base;
  }

  // 3) extras/delivery sin und
  return null;
}

// Línea principal estilo WhatsApp (▪️ ...), pero sirve perfecto para preview interno
function lineTextWhatsAppStyle(line: OrderLine) {
  const units = calcUnits(line);
  const bs = fmtBs(line.qty * line.priceBs);
  const isDelivery = !!line.isDelivery || line.name.toLowerCase().startsWith('delivery');

  if (isDelivery) {
    return `▪️ ${line.qty} ${line.name}: ${bs}`;
  }

  if (units !== null) {
    // limpiamos "(X und)" del nombre para evitar duplicación
    const cleanName = line.name.replace(/\s*\(\d+\s*und\)\s*/i, ' ').trim();
    return `▪️ ${line.qty} Serv. ${cleanName} (${units} und): ${bs}`;
  }

  return `▪️ ${line.qty} ${line.name}: ${bs}`;
}

// --- Progress bar ---
function getProgressFlow(fulfillment: Fulfillment): OrderStatus[] {
  // Fuente de verdad: semántica interna; solo para progreso visual.
  const flowDelivery: OrderStatus[] = [
    'created',
    'queued',
    'confirmed',
    'in_kitchen',
    'ready',
    'out_for_delivery',
    'delivered',
  ];

  const flowPickup: OrderStatus[] = ['created', 'queued', 'confirmed', 'in_kitchen', 'ready', 'delivered'];

  return fulfillment === 'delivery' ? flowDelivery : flowPickup;
}

function ProgressBar({ status, fulfillment }: { status: OrderStatus; fulfillment: Fulfillment }) {
  if (status === 'cancelled') {
    return (
      <div className="mt-1 h-1.5 w-full rounded-full bg-[#191926]">
        <div className="h-1.5 w-1/4 rounded-full bg-red-500" />
      </div>
    );
  }

  const flow = getProgressFlow(fulfillment);
  const idx = Math.max(0, flow.indexOf(status));
  const segments = Math.max(4, flow.length - 1); // segmentos compactos (pickup 5, delivery 6)
  const maxIndex = flow.length - 1;

  // Normalizamos a cantidad de segmentos:
  const filled = Math.round((Math.min(idx, maxIndex) / maxIndex) * segments);

  return (
    <div className="mt-1 flex gap-1">
      {Array.from({ length: segments }).map((_, i) => {
        const isOn = i < filled;
        return (
          <div
            key={i}
            className={['h-1.5 flex-1 rounded-full', isOn ? 'bg-[#FEEF00]' : 'bg-[#191926]'].join(' ')}
          />
        );
      })}
    </div>
  );
}

export default function MasterPedidosPage() {
  const [roleView, setRoleView] = useState<RoleView>('master');

  const [mode, setMode] = useState<'day' | 'range'>('day');
  const [macroFilter, setMacroFilter] = useState<MacroFilter>('all');

  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Mock data para visualizar (luego lo conectas a Supabase)
  const orders: OrderListItem[] = useMemo(
    () => [
      {
        id: 10452,
        orderNumber: '#10452',
        createdAtISO: new Date(Date.now() - 1000 * 60 * 120).toISOString(), // 2 horas atrás
        clientName: 'María Pérez',
        fulfillment: 'delivery',
        totalUsd: 54.55,
        balanceUsd: 6,
        status: 'confirmed',
        advisorName: 'Leo',
        hasNoteOrDetail: true,
        totalBs: 23220,
        lines: [
          { name: 'Mini Tequeños Fritos', qty: 2, unitsPerService: 25, priceBs: 5400 },
          { name: 'Empanadas Fritas', qty: 2, unitsPerService: 20, priceBs: 5400 },
          { name: 'Salsa Tártara 5oz', qty: 1, unitsPerService: 0, priceBs: 1080 },
          { name: 'Delivery Zona 2', qty: 1, unitsPerService: 0, priceBs: 1620, isDelivery: true },
        ],
      },
      {
        id: 10510,
        orderNumber: '#10510',
        createdAtISO: new Date(Date.now() - 1000 * 60 * 25).toISOString(),
        clientName: 'Carlos Núñez',
        fulfillment: 'pickup',
        totalUsd: 16.0,
        balanceUsd: 0,
        status: 'ready',
        advisorName: 'Mariangela',
        hasNoteOrDetail: true,
        totalBs: 8640,
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
        orderNumber: '#10522',
        createdAtISO: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
        clientName: 'Ana Rodríguez',
        fulfillment: 'delivery',
        totalUsd: 30,
        balanceUsd: 30,
        status: 'queued',
        advisorName: 'Yujanir',
        hasNoteOrDetail: false,
        totalBs: 16200,
        lines: [
          { name: 'Combo Rumba Mix Frito (76 und)', qty: 1, unitsPerService: 0, priceBs: 16200 },
          { name: 'Delivery Zona 1', qty: 1, unitsPerService: 0, priceBs: 1080, isDelivery: true },
        ],
      },
    ],
    []
  );

  const visibleOrders = useMemo(() => {
    // ✅ filtro + sort ascendente por hora
    const base = orders
      .filter((o) => matchesMacroFilter(o, macroFilter))
      .slice()
      .sort((a, b) => new Date(a.createdAtISO).getTime() - new Date(b.createdAtISO).getTime());

    if (roleView === 'advisor') {
      // Advisor: no muestra asesor
      return base.map((o) => ({ ...o, advisorName: undefined }));
    }
    return base;
  }, [orders, macroFilter, roleView]);

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      {/* Sticky Header */}
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-md px-4 pt-4 pb-3">
          <div className="flex items-center justify-between">
            <h1 className="text-xl font-semibold">Pedidos</h1>

            {/* Demo switch (para ver master vs advisor visualmente) */}
            <div className="flex items-center gap-2 text-xs">
              <span className="text-[#B7B7C2]">Vista</span>
              <select
                value={roleView}
                onChange={(e) => setRoleView(e.target.value as RoleView)}
                className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1"
              >
                <option value="master">Master</option>
                <option value="advisor">Advisor</option>
              </select>
            </div>
          </div>

          {/* Date Button + Toggle */}
          <div className="mt-3 flex items-center gap-3">
            <button
              className="flex-1 rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3 text-left"
              onClick={() => alert('Abrir calendario (demo)')}
            >
              <div className="text-sm font-medium">Hoy · Mar 4</div>
              <div className="text-xs text-[#B7B7C2]">Toca para cambiar</div>
            </button>

            <div className="flex flex-col items-end justify-center gap-1">
              <div className="text-[11px] text-[#B7B7C2]">Día / Rango</div>
              <button
                onClick={() => setMode((m) => (m === 'day' ? 'range' : 'day'))}
                className="relative h-8 w-20 rounded-full border border-[#242433] bg-[#121218]"
                aria-label="Toggle día/rango"
              >
                <span
                  className={[
                    'absolute top-1 h-6 w-9 rounded-full transition-all',
                    mode === 'day' ? 'left-1 bg-[#FEEF00]' : 'left-10 bg-[#FEEF00]',
                  ].join(' ')}
                />
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-[11px] text-[#0B0B0D]">
                  {mode === 'day' ? 'Día' : ''}
                </span>
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[#0B0B0D]">
                  {mode === 'range' ? 'Rango' : ''}
                </span>
              </button>
            </div>
          </div>

          {/* Chips */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
            <Chip active={macroFilter === 'all'} onClick={() => setMacroFilter('all')}>
              Todos
            </Chip>
            <Chip active={macroFilter === 'pending'} onClick={() => setMacroFilter('pending')}>
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-orange-500" />
                Pendientes
              </span>
            </Chip>
            <Chip active={macroFilter === 'in_progress'} onClick={() => setMacroFilter('in_progress')}>
              En proceso
            </Chip>
            <Chip active={macroFilter === 'done'} onClick={() => setMacroFilter('done')}>
              Finalizadas
            </Chip>
            <Chip active={false} onClick={() => alert('Abrir “Más” (demo)')}>
              Más ▾
            </Chip>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="mx-auto max-w-md px-4 py-4">
        <div className="space-y-3">
          {visibleOrders.map((o) => (
            <OrderCard
              key={o.id}
              order={o}
              expanded={expandedId === o.id}
              onToggle={() => setExpandedId((id) => (id === o.id ? null : o.id))}
              roleView={roleView}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Chip({
  children,
  active,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'whitespace-nowrap rounded-full border px-3 py-1.5 text-sm',
        active ? 'border-[#FEEF00] text-[#F5F5F7]' : 'border-[#242433] text-[#B7B7C2] hover:text-[#F5F5F7]',
        'bg-[#121218]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function OrderCard({
  order,
  expanded,
  onToggle,
  roleView,
}: {
  order: OrderListItem;
  expanded: boolean;
  onToggle: () => void;
  roleView: RoleView;
}) {
  const statusLabel = ORDER_STATUS_LABEL[order.status];

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#121218] shadow-sm">
      {/* Tap area */}
      <button onClick={onToggle} className="w-full px-4 py-3 text-left">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">{order.clientName}</div>

            <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[#B7B7C2]">
              <span>{order.orderNumber}</span>
              {order.hasNoteOrDetail ? <span title="Tiene detalle/nota">📝</span> : null}
              {roleView === 'master' && order.advisorName ? (
                <span className="text-[#B7B7C2]">· Asesor: {order.advisorName}</span>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <div className="text-sm font-medium">{fmtTime(order.createdAtISO)}</div>
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

        {/* Estado compacto + barra */}
        <div className="mt-2 text-sm text-[#F5F5F7]">{statusLabel}</div>
        <ProgressBar status={order.status} fulfillment={order.fulfillment} />
      </button>

      {/* Expanded preview */}
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
              onClick={() => alert('Ir a detalle (demo)')}
            >
              Ver ›
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PreviewLines({ order }: { order: OrderListItem }) {
  const ordered = orderMainLinesForPreview(order.lines);

  // ✅ Máximo 3 renglones principales
  const main = ordered.slice(0, 3);
  const restCount = Math.max(0, ordered.length - main.length);

  return (
    <>
      {main.map((line, idx) => {
        const mainText = lineTextWhatsAppStyle(line);
        return (
          <div key={idx} className="leading-5">
            <div className="text-[#F5F5F7]">{mainText}</div>

            {/* Detalle editable: * bullets (máx 4) */}
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
          </div>
        );
      })}

      {restCount > 0 ? <div className="text-[#8A8A96]">+ {restCount} más…</div> : null}
    </>
  );
}