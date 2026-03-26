// src/app/app/advisor/pedidos/new/page.tsx
'use client';

import React, { useMemo, useState } from 'react';

type Fulfillment = 'pickup' | 'delivery';

type Client = {
  id: string;
  full_name: string;
  phone: string;
};

type Product = {
  id: string;
  name: string;
  unitsPerService: number;
  priceBs: number;
  priceUsd: number;
  detailEditable: boolean;
  kind: 'service' | 'extra' | 'delivery';
};

type CartLine = {
  productId: string;
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
  const isDelivery = p.kind === 'delivery' || p.name.toLowerCase().startsWith('delivery');
  if (isDelivery) return `▪️ ${qty} ${p.name}: ${fmtBs(lineBs)}`;

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

export default function AdvisorCreateOrderPage() {
  const advisorName = 'Mariangela Montiel';

  const clients: Client[] = useMemo(
    () => [
      { id: 'c1', full_name: 'Judith Morillo', phone: '+58 414-6305309' },
      { id: 'c2', full_name: 'Ana Rodríguez', phone: '+58 414-1112233' },
      { id: 'c3', full_name: 'Carlos Núñez', phone: '+58 412-9998888' },
    ],
    []
  );

  const products: Product[] = useMemo(
    () => [
      { id: 'mini_teq_f', name: 'Mini Tequeños Fritos', unitsPerService: 25, priceBs: 5400, priceUsd: 10, detailEditable: false, kind: 'service' },
      { id: 'emp_f', name: 'Empanadas Fritas', unitsPerService: 20, priceBs: 5400, priceUsd: 10, detailEditable: false, kind: 'service' },
      { id: 'cach_f', name: 'Cachitas Fritas', unitsPerService: 20, priceBs: 5400, priceUsd: 10, detailEditable: false, kind: 'service' },
      { id: 'bombys_f', name: 'Bombys Fritos', unitsPerService: 25, priceBs: 5400, priceUsd: 10, detailEditable: false, kind: 'service' },

      { id: 'combo_baby', name: 'Combo Baby Mix Frito (25 und)', unitsPerService: 0, priceBs: 5940, priceUsd: 11, detailEditable: true, kind: 'service' },
      { id: 'combo_sexy', name: 'Combo Sexy Mix Frito (50 und)', unitsPerService: 0, priceBs: 10800, priceUsd: 20, detailEditable: true, kind: 'service' },

      { id: 'salsa_tar_2', name: 'Salsa Tártara 2oz', unitsPerService: 0, priceBs: 540, priceUsd: 1, detailEditable: false, kind: 'extra' },
      { id: 'salsa_tar_5', name: 'Salsa Tártara 5oz', unitsPerService: 0, priceBs: 1080, priceUsd: 2, detailEditable: false, kind: 'extra' },
      { id: 'pepsi_15', name: 'Pepsi 1,5 Lts', unitsPerService: 0, priceBs: 1080, priceUsd: 2, detailEditable: false, kind: 'extra' },

      { id: 'del_z1', name: 'Delivery Zona 1', unitsPerService: 0, priceBs: 1080, priceUsd: 2, detailEditable: false, kind: 'delivery' },
      { id: 'del_z2', name: 'Delivery Zona 2', unitsPerService: 0, priceBs: 1740, priceUsd: 4, detailEditable: false, kind: 'delivery' },
      { id: 'del_z3', name: 'Delivery Zona 3', unitsPerService: 0, priceBs: 2160, priceUsd: 4, detailEditable: false, kind: 'delivery' },
    ],
    []
  );

  const getProduct = (id: string) => products.find((p) => p.id === id) || null;

  const [clientQuery, setClientQuery] = useState('');
  const [selectedClient, setSelectedClient] = useState<Client | null>(null);

  const [createClientOpen, setCreateClientOpen] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientPhone, setNewClientPhone] = useState('');

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

  const noClientResult = clientQuery.trim().length >= 3 && filteredClients.length === 0;

  const selectClient = (c: Client) => {
    setSelectedClient(c);
    setClientQuery('');
  };

  const openCreateClient = () => {
    setCreateClientOpen(true);
    const q = clientQuery.trim();
    const qPhone = normalizePhone(q);
    if (qPhone.length >= 6) setNewClientPhone(q);
    else setNewClientName(q);
  };

  const saveClient = () => {
    const created: Client = {
      id: `new_${Date.now()}`,
      full_name: newClientName.trim() || 'Nuevo Cliente',
      phone: newClientPhone.trim(),
    };
    setSelectedClient(created);
    setCreateClientOpen(false);
    setNewClientName('');
    setNewClientPhone('');
    setClientQuery('');
    alert('Cliente creado (demo).');
  };

  const [fulfillment, setFulfillment] = useState<Fulfillment>('delivery');
  const [deliveryWhenMode, setDeliveryWhenMode] = useState<'today' | 'schedule'>('schedule');
  const [deliveryDate, setDeliveryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [deliveryTime, setDeliveryTime] = useState('15:00');

  const [deliveryAddress, setDeliveryAddress] = useState('Urbanizacion Los Olivos, Avenida 65 ( doble via) #75-33');
  const [deliveryZoneId, setDeliveryZoneId] = useState<string>('del_z2');

  const [fxRate, setFxRate] = useState<number>(433);

  const paymentMethods = [
    'Pago móvil',
    'Transferencia',
    'Efectivo Bs',
    'Divisa ($)',
    'Zelle',
    'Tarjeta / POS',
    'Otro',
  ] as const;
  type PaymentMethod = (typeof paymentMethods)[number];
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Pago móvil');

  const [discountEnabled, setDiscountEnabled] = useState(false);
  const [discountPct, setDiscountPct] = useState<number>(20);

  const [search, setSearch] = useState('');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const filteredCatalog = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return products
      .filter((p) => p.kind !== 'delivery')
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 12);
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

  const deliveryFee = useMemo(() => {
    if (fulfillment !== 'delivery') return null;
    return getProduct(deliveryZoneId);
  }, [fulfillment, deliveryZoneId, products]);

  const totalUsdBase = useMemo(() => {
    const itemsUsd = cartLinesDetailed.reduce((s, x) => s + x.lineUsd, 0);
    const delUsd = fulfillment === 'delivery' && deliveryFee ? deliveryFee.priceUsd : 0;
    return itemsUsd + delUsd;
  }, [cartLinesDetailed, fulfillment, deliveryFee]);

  const totalUsdFinal = useMemo(() => {
    const pct = discountEnabled ? clamp(safeNum(discountPct, 0), 0, 100) : 0;
    return totalUsdBase * (1 - pct / 100);
  }, [totalUsdBase, discountEnabled, discountPct]);

  const totalBsBase = useMemo(() => totalUsdBase * clamp(safeNum(fxRate, 0), 0, 999999), [totalUsdBase, fxRate]);
  const totalBsFinal = useMemo(() => totalUsdFinal * clamp(safeNum(fxRate, 0), 0, 999999), [totalUsdFinal, fxRate]);

  const canCreate = useMemo(() => {
    if (!selectedClient) return false;
    if (cartLinesDetailed.length === 0) return false;
    if (fulfillment === 'delivery') {
      if (!deliveryAddress.trim()) return false;
      if (!deliveryFee) return false;
    }
    if (safeNum(fxRate, 0) <= 0) return false;
    return true;
  }, [selectedClient, cartLinesDetailed.length, fulfillment, deliveryAddress, deliveryFee, fxRate]);

  const addProduct = (productId: string) => {
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

  const dec = (productId: string) =>
    setCart((prev) =>
      prev
        .map((x) => (x.productId === productId ? { ...x, qty: Math.max(0, x.qty - 1) } : x))
        .filter((x) => x.qty > 0)
    );

  const setDetail = (productId: string, text: string) =>
    setCart((prev) => prev.map((x) => (x.productId === productId ? { ...x, detailText: text } : x)));

  const [notes, setNotes] = useState('');

  const summaryLinesForApp = useMemo(() => {
    const services: typeof cartLinesDetailed = [];
    const extras: typeof cartLinesDetailed = [];

    for (const l of cartLinesDetailed) {
      if (l.product.kind === 'extra') extras.push(l);
      else services.push(l);
    }

    const lines: string[] = [];

    for (const l of services) {
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

    for (const l of extras) {
      const lineBs = l.lineUsd * fxRate;
      lines.push(productLineApp(l.product, l.qty, lineBs));
    }

    if (fulfillment === 'delivery' && deliveryFee) {
      lines.push(`▪️ 1 ${deliveryFee.name}: ${fmtBs(deliveryFee.priceUsd * fxRate)}`);
    }

    return lines;
  }, [cartLinesDetailed, fxRate, fulfillment, deliveryFee]);

  const whatsappText = useMemo(() => {
    if (!selectedClient) return '';

    const { dayDate, timeLower } = formatDeliveryDayDateTime(deliveryWhenMode, deliveryDate, deliveryTime);

    const services: typeof cartLinesDetailed = [];
    const extras: typeof cartLinesDetailed = [];

    for (const l of cartLinesDetailed) {
      if (l.product.kind === 'extra') extras.push(l);
      else services.push(l);
    }

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

    for (const l of services) {
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

    for (const l of extras) {
      const lineBs = l.lineUsd * fxRate;
      lines.push(productLineApp(l.product, l.qty, lineBs));
    }

    if (fulfillment === 'delivery' && deliveryFee) {
      lines.push(`▪️ 1 ${deliveryFee.name}: ${fmtBs(deliveryFee.priceUsd * fxRate)}`);
    }

    lines.push('');
    lines.push(`TOTAL: ${fmtBs(totalBsBase)} / ${fmtUSD(totalUsdBase)}`);
    if (discountEnabled) {
      lines.push(`Descuento ${discountPct}% ${fmtBs(totalBsFinal)} / ${fmtUSD(totalUsdFinal)}`);
    }

    lines.push('');
    lines.push(`✅ Forma de pago: ${paymentMethod}`);
    lines.push('');
    lines.push(`✅ Estatus del pago: pendiente`);
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
    fulfillment,
    deliveryFee,
    deliveryAddress,
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
      const ta = document.createElement('textarea');
      ta.value = whatsappText;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      alert('Copiado ✅');
    }
  };

  const handleCreate = () => {
    if (!canCreate) return;
    alert('Crear pedido (demo).');
  };

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="sticky top-0 z-50 border-b border-[#242433] bg-[#0B0B0D]/95 backdrop-blur">
        <div className="mx-auto max-w-md px-4 pb-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                className="rounded-lg border border-[#242433] bg-[#121218] px-2 py-1 text-sm"
                onClick={() => alert('Volver (demo)')}
              >
                ←
              </button>
              <div>
                <div className="text-lg font-semibold">Crear pedido</div>
                <div className="text-xs text-[#B7B7C2]">Se envía a Master para aprobación</div>
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
                  canCreate
                    ? { backgroundColor: BRAND_YELLOW, color: '#0B0B0D' }
                    : { backgroundColor: '#191926', color: '#8A8A96' }
                }
                disabled={!canCreate}
                onClick={handleCreate}
              >
                Crear
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-md space-y-5 px-4 py-5">
        <Card
          title="Cliente"
          right={
            <button className="text-xs text-[#B7B7C2] hover:text-[#F5F5F7]" onClick={openCreateClient}>
              + Cliente
            </button>
          }
        >
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

              {noClientResult ? (
                <div className="mt-2 rounded-2xl border border-[#242433] bg-[#121218] p-3">
                  <div className="text-sm text-[#B7B7C2]">No encontrado</div>
                  <button
                    className="mt-2 w-full rounded-xl bg-[#191926] px-3 py-2 text-sm"
                    onClick={openCreateClient}
                  >
                    Crear cliente con “{clientQuery.trim()}”
                  </button>
                </div>
              ) : null}
            </div>
          )}
        </Card>

        <Card title="Entrega">
          <div className="grid grid-cols-3 gap-2">
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
                <MiniPill
                  active={deliveryWhenMode === 'schedule'}
                  onClick={() => setDeliveryWhenMode('schedule')}
                >
                  Programar
                </MiniPill>
              </div>
            </div>

            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Hora</div>
              <input
                type="time"
                value={deliveryTime}
                onChange={(e) => setDeliveryTime(e.target.value)}
                className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-sm text-[#F5F5F7]"
              />
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

          {fulfillment === 'delivery' ? (
            <div className="mt-3 space-y-3">
              <div>
                <div className="mb-1 text-xs text-[#B7B7C2]">Dirección</div>
                <textarea
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder="Dirección completa"
                  className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                  rows={3}
                />
              </div>

              <div>
                <div className="mb-1 text-xs text-[#B7B7C2]">Zona delivery</div>
                <select
                  value={deliveryZoneId}
                  onChange={(e) => setDeliveryZoneId(e.target.value)}
                  className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7]"
                >
                  {products
                    .filter((p) => p.kind === 'delivery')
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {fmtBs(p.priceUsd * fxRate)} / {fmtUSD(p.priceUsd)}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-[#B7B7C2]">
              Entrega: <span className="text-[#F5F5F7]">PickUp</span>
            </div>
          )}
        </Card>

        <Card title="Pago">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="mb-1 text-xs text-[#B7B7C2]">Forma de pago</div>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as any)}
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
                placeholder="Escribe: mini, frito, salsa…"
                className="w-full rounded-3xl border border-[#2B2B3A] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] outline-none placeholder:text-[#8A8A96]"
              />

              {search.trim().length === 0 ? (
                <div className="text-sm text-[#B7B7C2]">Empieza a escribir para ver resultados.</div>
              ) : (
                <div className="space-y-2">
                  {filteredCatalog.map((p) => (
                    <div
                      key={p.id}
                      className="rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3"
                    >
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
                            placeholder="Una línea por item (ej: 10 Mini Tequeños.)"
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

        <Card title="Resumen">
          <div className="rounded-3xl border border-[#2B2B3A] bg-[#0B0B0D] p-4">
            <div className="mb-3 text-sm font-semibold tracking-[0.01em]">Pedido</div>

            <div className="space-y-1.5 text-sm leading-5">
              {summaryLinesForApp.length === 0 ? (
                <div className="text-[#B7B7C2]">Agrega productos para ver el resumen.</div>
              ) : (
                summaryLinesForApp.map((t, idx) => (
                  <div key={idx} className={t.startsWith('*') ? 'pl-4 text-[#B7B7C2]' : ''}>
                    {t}
                  </div>
                ))
              )}
            </div>

            <div className="mt-4 border-t border-[#242433] pt-3 text-sm font-semibold">
              TOTAL: {fmtBs(totalBsBase)} / {fmtUSD(totalUsdBase)}
            </div>

            {discountEnabled ? (
              <div className="text-sm font-semibold">
                Descuento {discountPct}% {fmtBs(totalBsFinal)} / {fmtUSD(totalUsdFinal)}
              </div>
            ) : null}
          </div>

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
            placeholder="Observaciones del pedido (empaque, facturación, etc.)"
            className="w-full rounded-2xl border border-[#242433] bg-[#0B0B0D] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
            rows={3}
          />
        </Card>

        <div className="pb-8">
          <button
            className="w-full rounded-2xl px-4 py-3 text-sm font-semibold"
            style={
              canCreate
                ? { backgroundColor: BRAND_YELLOW, color: '#0B0B0D' }
                : { backgroundColor: '#191926', color: '#8A8A96' }
            }
            disabled={!canCreate}
            onClick={handleCreate}
          >
            Crear pedido
          </button>
        </div>
      </div>

      {createClientOpen ? (
        <div className="fixed inset-0 z-[100]">
          <div className="absolute inset-0 bg-black/60" onClick={() => setCreateClientOpen(false)} />
          <div className="absolute left-1/2 top-1/2 w-[92%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[#242433] bg-[#0B0B0D] p-4">
            <div className="text-base font-semibold">Nuevo cliente</div>

            <div className="mt-3 space-y-3">
              <Field label="Nombre">
                <input
                  value={newClientName}
                  onChange={(e) => setNewClientName(e.target.value)}
                  placeholder="Nombre completo"
                  className="w-full rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                />
              </Field>

              <Field label="Teléfono">
                <input
                  value={newClientPhone}
                  onChange={(e) => setNewClientPhone(e.target.value)}
                  placeholder="+58 424-..."
                  className="w-full rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3 text-sm text-[#F5F5F7] placeholder:text-[#8A8A96]"
                />
              </Field>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-3 text-sm"
                onClick={() => setCreateClientOpen(false)}
              >
                Cancelar
              </button>
              <button
                className="rounded-2xl px-4 py-3 text-sm font-semibold"
                style={
                  newClientPhone.trim() && newClientName.trim()
                    ? { backgroundColor: BRAND_YELLOW, color: '#0B0B0D' }
                    : { backgroundColor: '#191926', color: '#8A8A96' }
                }
                disabled={!newClientPhone.trim() || !newClientName.trim()}
                onClick={saveClient}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      ) : null}
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