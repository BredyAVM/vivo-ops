'use client';

import React, { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { saveMasterOrderEditAction } from './actions';

type Fulfillment = 'pickup' | 'delivery';

type Client = {
  id: string;
  full_name: string;
  phone: string;
};

type Product = {
  id: number;
  name: string;
  sku: string;
  unitsPerService: number;
  priceBs: number;
  priceUsd: number;
  detailEditable: boolean;
  kind: 'service';
};

type CartLine = {
  productId: number;
  qty: number;
  detailText?: string;
};

const BRAND_YELLOW = '#FEEF00';

const fmtUSD = (n: number) => `$${n.toFixed(2)}`;

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

function normalizePhone(s: string) {
  return (s || '').replace(/[^\d]/g, '');
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function safeNum(n: unknown, fallback = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : fallback;
}

function productLineApp(p: Product, qty: number, lineBs: number) {
  if (p.unitsPerService > 0) {
    const units = qty * p.unitsPerService;
    return `▪️ ${qty} Serv. ${p.name} (${units} und): ${fmtBs(lineBs)}`;
  }

  return `▪️ ${qty} ${p.name}: ${fmtBs(lineBs)}`;
}

function formatDeliveryDayDateTime(
  deliveryWhenMode: 'today' | 'schedule',
  deliveryDate: string,
  deliveryTime: string
) {
  const [hh, mm] = deliveryTime.split(':').map((x) => Number(x));
  let dt: Date;

  if (deliveryWhenMode === 'schedule') {
    const [y, m, d] = deliveryDate.split('-').map((x) => Number(x));
    dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
  } else {
    dt = new Date();
    dt.setHours(hh || 0, mm || 0, 0, 0);
  }

  const dayName = dt.toLocaleDateString('es-VE', { weekday: 'long' });
  const dd = String(dt.getDate()).padStart(2, '0');
  const mo = String(dt.getMonth() + 1).padStart(2, '0');
  const yy = String(dt.getFullYear()).slice(-2);

  const timeLower = dt
    .toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })
    .replace(' ', '')
    .toLowerCase();

  return {
    dayDate: `${dayName} ${dd}/${mo}/${yy}`,
    timeLower,
  };
}

function to12HourParts(time24: string) {
  const [hRaw, mRaw] = String(time24 || '12:00').split(':');
  let hour24 = Number(hRaw || 12);
  const minute = String(mRaw || '00').padStart(2, '0');

  const ampm = hour24 >= 12 ? 'PM' : 'AM';

  if (hour24 === 0) hour24 = 12;
  else if (hour24 > 12) hour24 -= 12;

  return {
    hour12: String(hour24),
    minute,
    ampm: ampm as 'AM' | 'PM',
  };
}

function to24HourString(hour12: string, minute: string, ampm: 'AM' | 'PM') {
  let h = Number(hour12 || '12');

  if (ampm === 'AM') {
    if (h === 12) h = 0;
  } else {
    if (h !== 12) h += 12;
  }

  return `${String(h).padStart(2, '0')}:${String(minute || '00').padStart(2, '0')}`;
}

const MINUTE_OPTIONS = ['00', '05', '10', '15', '20', '25', '30', '35', '40', '45', '50', '55'];

export default function MasterEditOrderClient({
  orderId,
  orderNumber,
  status,
  advisorName,
  clients,
  selectedClient: initialSelectedClient,
  products,
  initialCart,
  initialFulfillment,
  initialDeliveryWhenMode,
  initialDeliveryDate,
  originalDeliveryDate,
  initialDeliveryTime,
  initialDeliveryAddress,
  initialReceiverName,
  initialReceiverPhone,
  initialPaymentMethod,
  initialFxRate,
  initialDiscountEnabled,
  initialDiscountPct,
  initialNotes,
}: {
  orderId: number;
  orderNumber: string;
  status: string;
  advisorName: string;
  clients: Client[];
  selectedClient: Client | null;
  products: Product[];
  initialCart: CartLine[];
  initialFulfillment: Fulfillment;
  initialDeliveryWhenMode: 'today' | 'schedule';
  initialDeliveryDate: string;
  originalDeliveryDate: string;
  initialDeliveryTime: string;
  initialDeliveryAddress: string;
  initialReceiverName: string;
  initialReceiverPhone: string;
  initialPaymentMethod: string;
  initialFxRate: number;
  initialDiscountEnabled: boolean;
  initialDiscountPct: number;
  initialNotes: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const initialTimeParts = to12HourParts(initialDeliveryTime);

  const [clientQuery, setClientQuery] = useState('');
  const [selectedClient, setSelectedClient] = useState<Client | null>(initialSelectedClient);

  const [fulfillment, setFulfillment] = useState<Fulfillment>(initialFulfillment);
  const [deliveryWhenMode, setDeliveryWhenMode] = useState<'today' | 'schedule'>(initialDeliveryWhenMode);
  const [deliveryDate, setDeliveryDate] = useState(initialDeliveryDate);

  const [deliveryHour12, setDeliveryHour12] = useState(initialTimeParts.hour12);
  const [deliveryMinute, setDeliveryMinute] = useState(initialTimeParts.minute);
  const [deliveryAmPm, setDeliveryAmPm] = useState<'AM' | 'PM'>(initialTimeParts.ampm);

  const [deliveryAddress, setDeliveryAddress] = useState(initialDeliveryAddress);

  const [receiverName, setReceiverName] = useState(initialReceiverName);
  const [receiverPhone, setReceiverPhone] = useState(initialReceiverPhone);

  const [fxRate, setFxRate] = useState<number>(initialFxRate);
  const [paymentMethod, setPaymentMethod] = useState(initialPaymentMethod);
  const [discountEnabled, setDiscountEnabled] = useState(initialDiscountEnabled);
  const [discountPct, setDiscountPct] = useState<number>(initialDiscountPct);

  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>(initialCart);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const [notes, setNotes] = useState(initialNotes);

  const deliveryTime = useMemo(
    () => to24HourString(deliveryHour12, deliveryMinute, deliveryAmPm),
    [deliveryHour12, deliveryMinute, deliveryAmPm]
  );

  const paymentMethods = [
    'Pago móvil',
    'Transferencia',
    'Efectivo Bs',
    'Divisa ($)',
    'Zelle',
    'Tarjeta / POS',
    'Otro',
  ] as const;

  const getProduct = (id: number) => products.find((p) => p.id === id) || null;

  const filteredClients = useMemo(() => {
    const q = clientQuery.trim().toLowerCase();
    if (!q) return [];
    const qPhone = normalizePhone(q);

    return clients
      .map((c) => {
        const name = c.full_name.toLowerCase();
        const phoneN = normalizePhone(c.phone);
        let score = 0;

        if (qPhone && phoneN.includes(qPhone)) score += qPhone.length >= 6 ? 50 : 20;
        if (name.includes(q)) score += 30;
        if (qPhone && phoneN === qPhone) score += 100;

        return { c, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((x) => x.c);
  }, [clientQuery, clients]);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [products, search]);

  const cartLinesDetailed = useMemo(() => {
    return cart
      .map((l) => {
        const p = getProduct(l.productId);
        if (!p) return null;
        return {
          ...l,
          product: p,
          lineUsd: l.qty * p.priceUsd,
        };
      })
      .filter(Boolean) as Array<CartLine & { product: Product; lineUsd: number }>;
  }, [cart, products]);

  const totalUsdBase = useMemo(() => {
    return cartLinesDetailed.reduce((s, x) => s + x.lineUsd, 0);
  }, [cartLinesDetailed]);

  const totalUsdFinal = useMemo(() => {
    const pct = discountEnabled ? clamp(safeNum(discountPct, 0), 0, 100) : 0;
    return totalUsdBase * (1 - pct / 100);
  }, [totalUsdBase, discountEnabled, discountPct]);

  const totalBsBase = useMemo(
    () => totalUsdBase * clamp(safeNum(fxRate, 0), 0, 999999),
    [totalUsdBase, fxRate]
  );
  const totalBsFinal = useMemo(
    () => totalUsdFinal * clamp(safeNum(fxRate, 0), 0, 999999),
    [totalUsdFinal, fxRate]
  );

  const canSave = useMemo(() => {
    if (!selectedClient) return false;
    if (cartLinesDetailed.length === 0) return false;
    if (safeNum(fxRate, 0) <= 0) return false;
    if (!receiverName.trim()) return false;
    if (!receiverPhone.trim()) return false;
    if (fulfillment === 'delivery' && !deliveryAddress.trim()) return false;
    return true;
  }, [
    selectedClient,
    cartLinesDetailed.length,
    fxRate,
    receiverName,
    receiverPhone,
    fulfillment,
    deliveryAddress,
  ]);

  const selectClient = (c: Client) => {
    setSelectedClient(c);
    setClientQuery('');
    if (!receiverName.trim()) setReceiverName(c.full_name);
    if (!receiverPhone.trim()) setReceiverPhone(c.phone);
  };

  const addProduct = (productId: number) => {
    setCart((prev) => {
      const idx = prev.findIndex((x) => x.productId === productId);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
        return next;
      }
      return [...prev, { productId, qty: 1 }];
    });
  };

  const dec = (productId: number) =>
    setCart((prev) =>
      prev
        .map((x) => (x.productId === productId ? { ...x, qty: Math.max(0, x.qty - 1) } : x))
        .filter((x) => x.qty > 0)
    );

  const removeProduct = (productId: number) =>
    setCart((prev) => prev.filter((x) => x.productId !== productId));

  const setDetail = (productId: number, text: string) =>
    setCart((prev) =>
      prev.map((x) => (x.productId === productId ? { ...x, detailText: text } : x))
    );

  const whatsappText = useMemo(() => {
    if (!selectedClient) return '';

    const { dayDate, timeLower } = formatDeliveryDayDateTime(
      deliveryWhenMode,
      deliveryDate,
      deliveryTime
    );

    const lines: string[] = [];
    lines.push('Resumen de Pedido');
    lines.push('');
    lines.push(`✅ Asesor: ${advisorName}`);
    lines.push('');
    lines.push(`✅ Cliente: ${selectedClient.full_name}`);
    lines.push('');
    lines.push(`✅ Teléfono: ${selectedClient.phone}`);
    lines.push('');
    lines.push('✅ Pedido:');
    lines.push('');

    for (const l of cartLinesDetailed) {
      const lineBs = l.lineUsd * fxRate;
      lines.push(productLineApp(l.product, l.qty, lineBs));

      if (l.product.detailEditable && l.detailText?.trim()) {
        const detailLines = l.detailText
          .split('\n')
          .map((x) => x.trim())
          .filter(Boolean);
        for (const dl of detailLines) lines.push(`* ${dl.replace(/^\*\s*/, '')}`);
      }
    }

    lines.push('');
    lines.push(`TOTAL: ${fmtBs(totalBsBase)} / ${fmtUSD(totalUsdBase)}`);
    if (discountEnabled) {
      lines.push(`Descuento ${discountPct}% ${fmtBs(totalBsFinal)} / ${fmtUSD(totalUsdFinal)}`);
    }

    lines.push('');
    lines.push(`✅ Forma de pago: ${paymentMethod}`);
    lines.push('');
    lines.push(`✅ Día de entrega: ${dayDate}`);
    lines.push('');
    lines.push(`✅ Hora: ${timeLower}`);
    lines.push('');

    if (fulfillment === 'delivery') {
      lines.push(`✅ Dirección: ${deliveryAddress}`);
    } else {
      lines.push(`✅ Entrega: PickUp`);
    }

    return lines.join('\n');
  }, [
    selectedClient,
    advisorName,
    cartLinesDetailed,
    fxRate,
    deliveryWhenMode,
    deliveryDate,
    deliveryTime,
    totalBsBase,
    totalUsdBase,
    discountEnabled,
    discountPct,
    totalBsFinal,
    totalUsdFinal,
    paymentMethod,
    fulfillment,
    deliveryAddress,
  ]);

  const copyWhatsApp = async () => {
    if (!whatsappText.trim()) {
      alert('Primero selecciona cliente y agrega productos.');
      return;
    }
    try {
      await navigator.clipboard.writeText(whatsappText);
      alert('Copiado ✅');
    } catch {
      alert('No se pudo copiar.');
    }
  };

  const handleSave = () => {
    if (!canSave) return;

    startTransition(async () => {
      try {
        await saveMasterOrderEditAction({
          orderId,
          clientId: selectedClient ? Number(selectedClient.id) : null,
          fulfillment,
          deliveryWhenMode,
          deliveryDate,
          deliveryTime,
          deliveryAddress,
          receiverName,
          receiverPhone,
          paymentMethod,
          fxRate,
          discountEnabled,
          discountPct,
          notes,
          items: cart.map((x) => ({
            productId: x.productId,
            qty: x.qty,
            detailText: x.detailText ?? '',
          })),
        });

        alert('Cambios guardados ✅');
        window.location.replace(
  `/app/master/dashboard?focusDate=${encodeURIComponent(originalDeliveryDate)}&t=${Date.now()}`
);
return;

      } catch (err) {
        const message = err instanceof Error ? err.message : 'No se pudo guardar.';
        alert(message);
      }
    });
  };

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-md px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm"
                onClick={() => router.back()}
              >
                ←
              </button>
              <div>
                <div className="text-lg font-semibold">Modificar pedido</div>
                <div className="text-xs text-[#B7B7C2]">
                  {orderNumber} · Estado: {status}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                onClick={copyWhatsApp}
                title="Copiar WhatsApp"
              >
                📋 Copiar
              </button>

              <button
                className="rounded-xl px-3 py-2 text-sm font-semibold"
                style={
                  canSave
                    ? { backgroundColor: BRAND_YELLOW, color: '#0B0B0D' }
                    : { backgroundColor: '#191926', color: '#8A8A96' }
                }
                disabled={!canSave || isPending}
                onClick={handleSave}
              >
                {isPending ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-md space-y-5 px-4 py-5">
        <Card title="Cliente">
          {selectedClient ? (
            <div className="rounded-3xl border border-[#2B2B3A] bg-[#0B0B0D] p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-semibold">{selectedClient.full_name}</div>
                  <div className="mt-1 text-xs text-[#B7B7C2]">{selectedClient.phone}</div>
                </div>
                <button
                  className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]"
                  onClick={() => setSelectedClient(null)}
                >
                  Cambiar
                </button>
              </div>
            </div>
          ) : (
            <div className="relative">
              <input
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Buscar por nombre o teléfono…"
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
              />

              {filteredClients.length > 0 ? (
                <div className="absolute z-20 mt-2 w-full overflow-hidden rounded-2xl border border-[#242433] bg-[#0B0B0D]">
                  {filteredClients.map((c) => (
                    <button
                      key={c.id}
                      className="w-full px-4 py-3 text-left hover:bg-[#121218]"
                      onClick={() => selectClient(c)}
                    >
                      <div className="text-sm font-semibold">{c.full_name}</div>
                      <div className="text-xs text-[#B7B7C2]">{c.phone}</div>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </Card>

        <Card title="Entrega">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Tipo</div>
              <div className="flex gap-1">
                <MiniPill active={fulfillment === 'pickup'} onClick={() => setFulfillment('pickup')}>
                  Pickup
                </MiniPill>
                <MiniPill active={fulfillment === 'delivery'} onClick={() => setFulfillment('delivery')}>
                  Delivery
                </MiniPill>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Cuándo</div>
              <div className="flex gap-1">
                <MiniPill active={deliveryWhenMode === 'today'} onClick={() => setDeliveryWhenMode('today')}>
                  Hoy
                </MiniPill>
                <MiniPill active={deliveryWhenMode === 'schedule'} onClick={() => setDeliveryWhenMode('schedule')}>
                  Programar
                </MiniPill>
              </div>
            </div>
          </div>

          {deliveryWhenMode === 'schedule' ? (
            <div className="mt-3">
              <div className="mb-1 text-xs text-[#B7B7C2]">Fecha</div>
              <input
                type="date"
                value={deliveryDate}
                onChange={(e) => setDeliveryDate(e.target.value)}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
            </div>
          ) : null}

          <div className="mt-3">
  <div className="mb-1 text-xs text-[#B7B7C2]">Hora</div>

  <div className="flex items-center gap-2">
    <select
      value={deliveryHour12}
      onChange={(e) => setDeliveryHour12(e.target.value)}
      className="w-[72px] rounded-xl border border-[#242433] bg-[#0B0B0D] px-2 py-2 text-xs text-[#F5F5F7]"
    >
      {Array.from({ length: 12 }).map((_, idx) => {
        const n = idx + 1;
        return (
          <option key={n} value={String(n)}>
            {n}
          </option>
        );
      })}
    </select>

    <span className="text-xs text-[#8A8A96]">:</span>

    <select
      value={deliveryMinute}
      onChange={(e) => setDeliveryMinute(e.target.value)}
      className="w-[76px] rounded-xl border border-[#242433] bg-[#0B0B0D] px-2 py-2 text-xs text-[#F5F5F7]"
    >
      {MINUTE_OPTIONS.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>

    <select
      value={deliveryAmPm}
      onChange={(e) => setDeliveryAmPm(e.target.value as 'AM' | 'PM')}
      className="w-[76px] rounded-xl border border-[#242433] bg-[#0B0B0D] px-2 py-2 text-xs text-[#F5F5F7]"
    >
      <option value="AM">AM</option>
      <option value="PM">PM</option>
    </select>
  </div>
</div>

          <div className="mt-3 grid grid-cols-1 gap-3">
            <Field label="Recibe">
              <input
                value={receiverName}
                onChange={(e) => setReceiverName(e.target.value)}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7]"
              />
            </Field>

            <Field label="Teléfono receptor">
              <input
                value={receiverPhone}
                onChange={(e) => setReceiverPhone(e.target.value)}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7]"
              />
            </Field>
          </div>

          {fulfillment === 'delivery' ? (
            <div className="mt-3">
              <div className="mb-1 text-xs text-[#B7B7C2]">Dirección</div>
              <textarea
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="Dirección completa"
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                rows={3}
              />
            </div>
          ) : null}
        </Card>

        <Card title="Pago">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Forma de pago</div>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7]"
              >
                {paymentMethods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Tasa del día</div>
              <input
                type="number"
                value={fxRate}
                onChange={(e) => setFxRate(safeNum(e.target.value, 0))}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7]"
                step="0.01"
                min="0"
              />
            </div>
          </div>

          <div className="mt-3 rounded-2xl border border-[#242433] bg-[#0B0B0D] p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Descuento</div>
              <button
                className="rounded-full border bg-[#121218] px-3 py-1 text-xs"
                style={
                  discountEnabled
                    ? { borderColor: BRAND_YELLOW, color: '#F5F5F7' }
                    : { borderColor: '#242433', color: '#B7B7C2' }
                }
                onClick={() => setDiscountEnabled((v) => !v)}
              >
                {discountEnabled ? 'Activado' : 'Desactivado'}
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 items-end gap-2">
              <div>
                <div className="mb-1 text-xs text-[#B7B7C2]">% descuento</div>
                <input
                  type="number"
                  value={discountPct}
                  onChange={(e) => setDiscountPct(clamp(safeNum(e.target.value, 0), 0, 100))}
                  disabled={!discountEnabled}
                  className={[
                    'w-full rounded-2xl border px-4 py-3 text-sm',
                    discountEnabled
                      ? 'border-[#242433] bg-[#0B0B0D] text-[#F5F5F7]'
                      : 'border-[#242433] bg-[#121218] text-[#8A8A96]',
                  ].join(' ')}
                />
              </div>

              <div className="text-xs text-[#B7B7C2]">
                Base: <span className="text-[#F5F5F7]">{fmtUSD(totalUsdBase)}</span>
                <br />
                Final: <span className="text-[#F5F5F7]">{fmtUSD(totalUsdFinal)}</span>
              </div>
            </div>
          </div>
        </Card>

        <Card
          title="Productos"
          right={
            <button
              className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]"
              onClick={() => setCatalogOpen((v) => !v)}
            >
              {catalogOpen ? 'Cerrar' : 'Agregar'}
            </button>
          }
        >
          {catalogOpen ? (
            <div className="space-y-3">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Escribe: mini, combo, salsa…"
                className="w-full rounded-3xl border border-[#2B2B3A] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] outline-none placeholder:text-[#8A8A96]"
              />

              {search.trim().length === 0 ? (
                <div className="text-sm text-[#B7B7C2]">Empieza a escribir para ver resultados.</div>
              ) : (
                <div className="space-y-2">
                  {filteredCatalog.map((p) => (
                    <div key={p.id} className="rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold">{p.name}</div>
                          <div className="mt-1 text-xs text-[#B7B7C2]">
                            {fmtBs(p.priceUsd * fxRate)} / {fmtUSD(p.priceUsd)}
                            {p.unitsPerService > 0
                              ? ` · ${p.unitsPerService} und/serv.`
                              : p.detailEditable
                                ? ' · Detalle editable'
                                : ''}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                            onClick={() => dec(p.id)}
                          >
                            −
                          </button>
                          <div className="w-6 text-center text-sm font-semibold">
                            {cart.find((x) => x.productId === p.id)?.qty ?? 0}
                          </div>
                          <button
                            className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                            onClick={() => addProduct(p.id)}
                          >
                            +
                          </button>
                        </div>
                      </div>

                      {p.detailEditable && (cart.find((x) => x.productId === p.id)?.qty ?? 0) > 0 ? (
                        <div className="mt-2">
                          <div className="text-xs text-[#B7B7C2]">Detalle</div>
                          <textarea
                            value={cart.find((x) => x.productId === p.id)?.detailText ?? ''}
                            onChange={(e) => setDetail(p.id, e.target.value)}
                            placeholder="Una línea por item"
                            className="mt-1 w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                            rows={2}
                          />
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-[#B7B7C2]">Catálogo oculto.</div>
          )}
        </Card>

        <Card title="Resumen editable">
          {cartLinesDetailed.length === 0 ? (
            <div className="text-sm text-[#B7B7C2]">Agrega productos para ver el resumen.</div>
          ) : (
            <div className="space-y-3">
              {cartLinesDetailed.map((line) => (
                <div
                  key={line.productId}
                  className="rounded-2xl border border-[#242433] bg-[#0B0B0D] p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[#F5F5F7]">
                        {line.product.name}
                      </div>
                      <div className="mt-1 text-xs text-[#B7B7C2]">
                        {line.product.unitsPerService > 0
                          ? `${line.product.unitsPerService} und/serv. · `
                          : ''}
                        {fmtUSD(line.product.priceUsd)} c/u
                      </div>
                    </div>

                    <button
                      className="rounded-xl border border-red-500 bg-[#0B0B0D] px-3 py-1.5 text-xs text-red-400"
                      onClick={() => removeProduct(line.productId)}
                    >
                      Eliminar
                    </button>
                  </div>

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <button
                        className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                        onClick={() => dec(line.productId)}
                      >
                        −
                      </button>

                      <div className="min-w-[32px] text-center text-sm font-semibold">
                        {line.qty}
                      </div>

                      <button
                        className="rounded-xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm"
                        onClick={() => addProduct(line.productId)}
                      >
                        +
                      </button>
                    </div>

                    <div className="text-right">
                      <div className="text-sm font-semibold text-[#F5F5F7]">
                        {fmtUSD(line.lineUsd)}
                      </div>
                      <div className="text-xs text-[#B7B7C2]">
                        {fmtBs(line.lineUsd * fxRate)}
                      </div>
                    </div>
                  </div>

                  {line.product.detailEditable ? (
                    <div className="mt-3">
                      <div className="mb-1 text-xs text-[#B7B7C2]">Detalle</div>
                      <textarea
                        value={line.detailText ?? ''}
                        onChange={(e) => setDetail(line.productId, e.target.value)}
                        placeholder="Una línea por item"
                        className="w-full rounded-2xl border border-[#242433] bg-[#121218] px-3 py-2 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                        rows={2}
                      />
                    </div>
                  ) : null}
                </div>
              ))}

              <div className="rounded-2xl border border-[#242433] bg-[#0B0B0D] p-4">
                <div className="text-sm font-semibold">
                  TOTAL: {fmtBs(totalBsBase)} / {fmtUSD(totalUsdBase)}
                </div>

                {discountEnabled ? (
                  <div className="mt-1 text-sm font-semibold">
                    Descuento {discountPct}% {fmtBs(totalBsFinal)} / {fmtUSD(totalUsdFinal)}
                  </div>
                ) : null}
              </div>
            </div>
          )}

          <div className="mt-3">
            <button
              className="w-full rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3 text-sm"
              onClick={copyWhatsApp}
              title="Copiar al portapapeles para WhatsApp"
            >
              📋 Copiar WhatsApp
            </button>
          </div>
        </Card>

        <Card title="Notas (opcional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Observaciones del pedido"
            className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
            rows={3}
          />
        </Card>

        <div className="pb-8">
          <button
            className="w-full rounded-2xl px-4 py-3 text-sm font-semibold"
            style={
              canSave
                ? { backgroundColor: BRAND_YELLOW, color: '#0B0B0D' }
                : { backgroundColor: '#191926', color: '#8A8A96' }
            }
            disabled={!canSave || isPending}
            onClick={handleSave}
          >
            {isPending ? 'Guardando...' : 'Guardar cambios'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Card({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-[#242433] bg-[#121218] p-4 shadow-[0_6px_24px_rgba(0,0,0,0.18)]">
      <div className="flex items-center justify-between">
        <div className="text-[15px] font-semibold tracking-[0.01em]">{title}</div>
        {right}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-[#B7B7C2]">{label}</div>
      {children}
    </div>
  );
}

function MiniPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="rounded-full border bg-[#121218] px-2 py-1 text-xs"
      style={
        active
          ? { borderColor: BRAND_YELLOW, color: '#F5F5F7' }
          : { borderColor: '#242433', color: '#B7B7C2' }
      }
    >
      {children}
    </button>
  );
}