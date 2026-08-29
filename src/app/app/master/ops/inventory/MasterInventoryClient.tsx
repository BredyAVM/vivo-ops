'use client';

import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  inventoryCountFolio,
  inventoryCountKindLabels,
  inventoryCountTitle,
} from '@/app/app/inventory/count-presentation';
import {
  cancelMasterInventoryExpectedReceiptAction,
  cancelMasterInventorySuspensionAction,
  requestMasterInventoryCountAction,
  saveMasterInventoryExpectedReceiptAction,
  saveMasterInventoryProtectedBalanceAction,
  saveMasterInventoryProductSuspensionAction,
  saveMasterInventorySuspensionAction,
} from './actions';

export type MasterInventoryItem = {
  id: number;
  name: string;
  unitName: string;
  inventoryGroup: string;
  currentStockUnits: number;
  commitmentUnits: number;
  commitmentCount: number;
  laterCommitmentUnits: number;
  availableWithoutIncomingUnits: number | null;
  projectedAvailableUnits: number | null;
  minimumProjectedAt: string | null;
  dependsOnIncoming: boolean;
  lowStockThreshold: number | null;
  targetStockUnits: number | null;
  primaryCountFrequency: string | null;
  isLowStock: boolean;
  pendingCountId: number | null;
  lastCountId: number | null;
  lastCountedUnits: number | null;
  lastCountedAt: string | null;
  lastCountedByName: string | null;
  lastCountAgeText: string;
};

export type MasterInventoryCount = {
  id: number;
  countKind: string;
  status: string;
  responsibleRole: string;
  parentCountId: number | null;
  dueAt: string | null;
  submittedAt: string | null;
  reviewedAt: string | null;
  notes: string | null;
  createdAt: string;
  shiftBusinessDate: string | null;
  lineCount: number;
  varianceCount: number;
  itemNames: string[];
};

export type MasterInventorySupply = {
  id: number;
  type: 'expected_receipt' | 'planned_production';
  inventoryItemId: number;
  itemName: string;
  unitName: string;
  quantityUnits: number;
  effectiveAt: string;
  sourceName: string | null;
  recipeId: number | null;
  notes: string | null;
};

export type MasterInventoryAlert = {
  id: number;
  category: string;
  type: string;
  severity: 'warning' | 'critical';
  inventoryItemId: number | null;
  inventoryItemName: string | null;
  title: string;
  message: string | null;
  lastDetectedAt: string;
};

export type MasterInventorySuspension = {
  id: number;
  scope: 'product' | 'inventory_item';
  productId: number | null;
  inventoryItemId: number;
  itemName: string;
  unitName: string;
  availableFrom: string | null;
  notes: string | null;
  createdAt: string;
};

export type MasterInventoryFamilyOption = {
  productId: number;
  productName: string;
  primaryInventoryItemId: number;
  primaryItemName: string;
  primaryUnitName: string;
  fallbackInventoryItemId: number;
  fallbackItemName: string;
  rawUnitsPerPrefriedUnit: number;
};

export type MasterInventoryProtection = {
  id: number;
  primaryInventoryItemId: number;
  primaryItemName: string;
  primaryUnitName: string;
  fallbackInventoryItemId: number;
  fallbackItemName: string;
  safetyReserveUnits: number;
  expectedFlowId: number | null;
  availableFrom: string | null;
  notes: string | null;
  createdAt: string;
};

export type MasterInventoryProduct = {
  id: number;
  sku: string | null;
  name: string;
  type: string;
  inventoryPolicy: string | null;
};

type MasterInventoryView = 'overview' | 'stock' | 'supplies' | 'counts';

const groupOrder = ['raw', 'fried', 'prefried', 'sauces', 'beverages', 'packaging', 'other'];

const groupLabels: Record<string, string> = {
  raw: 'Crudos',
  fried: 'Fritos',
  prefried: 'Prefritos',
  sauces: 'Salsas y bases',
  beverages: 'Bebidas',
  packaging: 'Empaques y consumibles',
  other: 'Otros productos',
};

const countKindLabels = inventoryCountKindLabels;

const statusLabels: Record<string, string> = {
  open: 'Esperando a Cocina',
  submitted: 'Esperando a Máster',
  accepted: 'Aceptado',
  recount_requested: 'Reconteo solicitado',
  expired: 'Vencido',
  cancelled: 'Cancelado',
};

const inputClass = 'w-full rounded-xl border border-[#343444] bg-[#0B0B10] px-3 py-2.5 text-white outline-none focus:border-[#FEEF00]/70';

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function inventoryValueClass(value: number | null, warning = false) {
  if (value == null) return 'text-[#777784]';
  if (value < -0.005) return 'text-rose-300';
  if (value <= 0.005 || warning) return 'text-amber-300';
  return 'text-white';
}

function inventoryRiskRank(item: MasterInventoryItem) {
  if (item.projectedAvailableUnits != null && item.projectedAvailableUnits < -0.005) return 4;
  if (item.availableWithoutIncomingUnits != null && item.availableWithoutIncomingUnits < -0.005) return 3;
  if (item.dependsOnIncoming) return 2;
  if (item.isLowStock) return 1;
  return 0;
}

function countItemSummary(count: MasterInventoryCount) {
  if (!count.itemNames.length) return `${count.lineCount} ítems`;
  const visible = count.itemNames.slice(0, 3).join(', ');
  const remaining = count.itemNames.length - 3;
  return remaining > 0 ? `${visible} y ${remaining} más` : visible;
}

export default function MasterInventoryClient({
  initialView,
  products,
  items,
  counts,
  supplies,
  alerts,
  families,
  protections,
  suspensions,
}: {
  initialView: MasterInventoryView;
  products: MasterInventoryProduct[];
  items: MasterInventoryItem[];
  counts: MasterInventoryCount[];
  supplies: MasterInventorySupply[];
  alerts: MasterInventoryAlert[];
  families: MasterInventoryFamilyOption[];
  protections: MasterInventoryProtection[];
  suspensions: MasterInventorySuspension[];
}) {
  const router = useRouter();
  const [activeView, setActiveView] = useState<MasterInventoryView>(initialView);
  const [search, setSearch] = useState('');
  const [requestGroup, setRequestGroup] = useState('all');
  const [stockSearch, setStockSearch] = useState('');
  const [stockGroup, setStockGroup] = useState('all');
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [dueAt, setDueAt] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [createdCountId, setCreatedCountId] = useState<number | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isRefreshing, startRefresh] = useTransition();
  const [receiptItemId, setReceiptItemId] = useState('');
  const [receiptQuantity, setReceiptQuantity] = useState('');
  const [receiptQuantityUnknown, setReceiptQuantityUnknown] = useState(false);
  const [receiptEffectiveAt, setReceiptEffectiveAt] = useState('');
  const [receiptSource, setReceiptSource] = useState('');
  const [receiptNotes, setReceiptNotes] = useState('');
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptSuccess, setReceiptSuccess] = useState<string | null>(null);
  const [isSavingReceipt, startReceiptTransition] = useTransition();
  const [cancellingSupplyId, setCancellingSupplyId] = useState<number | null>(null);
  const [protectionItemId, setProtectionItemId] = useState('');
  const [protectionExpectedFlowId, setProtectionExpectedFlowId] = useState('');
  const [protectionReserve, setProtectionReserve] = useState('0');
  const [protectionNotes, setProtectionNotes] = useState('');
  const [protectionError, setProtectionError] = useState<string | null>(null);
  const [protectionSuccess, setProtectionSuccess] = useState<string | null>(null);
  const [isSavingProtection, startProtectionTransition] = useTransition();
  const [cancellingProtectionId, setCancellingProtectionId] = useState<number | null>(null);
  const [suspensionItemId, setSuspensionItemId] = useState('');
  const [suspensionScope, setSuspensionScope] = useState<'product' | 'inventory_item'>('product');
  const [suspensionProductId, setSuspensionProductId] = useState('');
  const [suspensionIndefinite, setSuspensionIndefinite] = useState(false);
  const [suspensionAvailableFrom, setSuspensionAvailableFrom] = useState('');
  const [suspensionNotes, setSuspensionNotes] = useState('');
  const [suspensionError, setSuspensionError] = useState<string | null>(null);
  const [suspensionSuccess, setSuspensionSuccess] = useState<string | null>(null);
  const [isSavingSuspension, startSuspensionTransition] = useTransition();
  const [cancellingSuspensionId, setCancellingSuspensionId] = useState<number | null>(null);

  const waitingKitchen = counts.filter((count) => count.status === 'open');
  const waitingMaster = counts
    .filter((count) => count.status === 'submitted')
    .sort((left, right) => new Date(left.submittedAt ?? left.createdAt).getTime() - new Date(right.submittedAt ?? right.createdAt).getTime());
  const recentCounts = counts.filter((count) => !['open', 'submitted'].includes(count.status)).slice(0, 12);
  const lowStockCount = items.filter((item) => item.isLowStock).length;
  const dependsOnIncomingCount = items.filter((item) => item.dependsOnIncoming).length;
  const attentionItems = useMemo(
    () => [...items]
      .filter((item) => inventoryRiskRank(item) > 0)
      .sort((left, right) => inventoryRiskRank(right) - inventoryRiskRank(left) || left.name.localeCompare(right.name, 'es'))
      .slice(0, 8),
    [items],
  );
  const selectableItems = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('es');
    return items.filter((item) => {
      if (requestGroup !== 'all' && item.inventoryGroup !== requestGroup) return false;
      if (!query) return true;
      return `${item.name} ${groupLabels[item.inventoryGroup] ?? item.inventoryGroup}`.toLocaleLowerCase('es').includes(query);
    });
  }, [items, requestGroup, search]);
  const availableGroups = useMemo(
    () => groupOrder.filter((group) => items.some((item) => item.inventoryGroup === group)),
    [items],
  );
  const visibleStock = useMemo(() => {
    const query = stockSearch.trim().toLocaleLowerCase('es');
    return [...items]
      .filter((item) => stockGroup === 'all' || item.inventoryGroup === stockGroup)
      .filter((item) => !query || `${item.name} ${groupLabels[item.inventoryGroup] ?? item.inventoryGroup}`.toLocaleLowerCase('es').includes(query))
      .sort((left, right) => left.name.localeCompare(right.name, 'es'));
  }, [items, stockGroup, stockSearch]);
  const stockSections = useMemo(
    () => availableGroups
      .map((group) => ({
        group,
        label: groupLabels[group] ?? group,
        items: visibleStock.filter((item) => item.inventoryGroup === group),
      }))
      .filter((section) => section.items.length > 0),
    [availableGroups, visibleStock],
  );
  const selectedProtectionFamily = families.find(
    (family) => family.primaryInventoryItemId === Number(protectionItemId),
  ) ?? null;
  const protectionReceipts = supplies.filter((supply) => (
    supply.type === 'expected_receipt'
    && supply.inventoryItemId === selectedProtectionFamily?.primaryInventoryItemId
    && supply.quantityUnits > 0
  ));

  function toggleItem(itemId: number) {
    setSelectedIds((current) => current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId]);
  }

  function showView(view: MasterInventoryView) {
    setActiveView(view);
    window.history.replaceState(null, '', `/app/master/ops/inventory?view=${view}`);
  }

  function selectVisible() {
    const selectableIds = selectableItems.filter((item) => item.pendingCountId == null).map((item) => item.id);
    setSelectedIds((current) => Array.from(new Set([...current, ...selectableIds])));
  }

  function submitRequest() {
    setError(null);
    setCreatedCountId(null);
    if (!selectedIds.length) {
      setError('Selecciona al menos un ítem para solicitar el conteo.');
      return;
    }

    let dueAtIso: string | null = null;
    if (dueAt) {
      const parsedDueAt = new Date(dueAt);
      if (!Number.isFinite(parsedDueAt.getTime())) {
        setError('Revisa la fecha límite.');
        return;
      }
      dueAtIso = parsedDueAt.toISOString();
    }

    startTransition(async () => {
      try {
        const result = await requestMasterInventoryCountAction({
          operationId: crypto.randomUUID(),
          inventoryItemIds: selectedIds,
          dueAt: dueAtIso,
          notes,
        });
        setCreatedCountId(result.countId);
        setSelectedIds([]);
        setDueAt('');
        setNotes('');
        router.refresh();
      } catch (submissionError) {
        setError(submissionError instanceof Error ? submissionError.message : 'No se pudo solicitar el conteo.');
      }
    });
  }

  function submitExpectedReceipt() {
    setReceiptError(null);
    setReceiptSuccess(null);
    const inventoryItemId = Number(receiptItemId);
    const quantityUnits = Number(receiptQuantity);

    if (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0) {
      setReceiptError('Selecciona el producto que se espera recibir.');
      return;
    }
    if (!receiptEffectiveAt) {
      setReceiptError('Indica la fecha y hora estimada de llegada.');
      return;
    }
    if (!receiptQuantityUnknown && (!Number.isFinite(quantityUnits) || quantityUnits <= 0)) {
      setReceiptError('Indica una cantidad mayor que cero o marca que está por confirmar.');
      return;
    }

    startReceiptTransition(async () => {
      try {
        const result = await saveMasterInventoryExpectedReceiptAction({
          operationId: crypto.randomUUID(),
          inventoryItemId,
          effectiveAt: new Date(receiptEffectiveAt).toISOString(),
          quantityUnits: receiptQuantityUnknown ? null : quantityUnits,
          quantityUnknown: receiptQuantityUnknown,
          sourceName: receiptSource,
          notes: receiptNotes,
        });
        setReceiptSuccess(`Entrada esperada #${result.expectedFlowId} registrada.`);
        setReceiptQuantity('');
        setReceiptQuantityUnknown(false);
        setReceiptEffectiveAt('');
        setReceiptSource('');
        setReceiptNotes('');
        router.refresh();
      } catch (submissionError) {
        setReceiptError(submissionError instanceof Error ? submissionError.message : 'No se pudo registrar la entrada esperada.');
      }
    });
  }

  function cancelExpectedReceipt(supplyId: number) {
    if (!window.confirm('¿Cancelar esta entrada esperada? La existencia física no cambiará.')) return;
    setReceiptError(null);
    setReceiptSuccess(null);
    setCancellingSupplyId(supplyId);
    startReceiptTransition(async () => {
      try {
        await cancelMasterInventoryExpectedReceiptAction({
          expectedFlowId: supplyId,
          notes: 'Cancelada desde el control operativo de Máster.',
        });
        setReceiptSuccess(`Entrada esperada #${supplyId} cancelada.`);
        router.refresh();
      } catch (submissionError) {
        setReceiptError(submissionError instanceof Error ? submissionError.message : 'No se pudo cancelar la entrada esperada.');
      } finally {
        setCancellingSupplyId(null);
      }
    });
  }

  function submitProtection() {
    setProtectionError(null);
    setProtectionSuccess(null);
    const primaryInventoryItemId = Number(protectionItemId);
    const expectedFlowId = protectionExpectedFlowId ? Number(protectionExpectedFlowId) : null;
    const safetyReserveUnits = Number(protectionReserve || 0);
    if (!Number.isSafeInteger(primaryInventoryItemId) || primaryInventoryItemId <= 0) {
      setProtectionError('Selecciona la familia que se venderá solo hasta agotar el saldo.');
      return;
    }
    if (!Number.isFinite(safetyReserveUnits) || safetyReserveUnits < 0) {
      setProtectionError('La reserva debe ser cero o una cantidad positiva.');
      return;
    }

    startProtectionTransition(async () => {
      try {
        const result = await saveMasterInventoryProtectedBalanceAction({
          operationId: crypto.randomUUID(),
          primaryInventoryItemId,
          expectedFlowId,
          safetyReserveUnits,
          notes: protectionNotes,
        });
        setProtectionSuccess(`Protección #${result.protectionFlowId} activada.`);
        setProtectionItemId('');
        setProtectionExpectedFlowId('');
        setProtectionReserve('0');
        setProtectionNotes('');
        router.refresh();
      } catch (submissionError) {
        setProtectionError(submissionError instanceof Error ? submissionError.message : 'No se pudo proteger el saldo de venta.');
      }
    });
  }

  function cancelProtection(protectionId: number) {
    if (!window.confirm('¿Liberar esta protección? El inventario normal volverá a ser solo informativo.')) return;
    setProtectionError(null);
    setProtectionSuccess(null);
    setCancellingProtectionId(protectionId);
    startProtectionTransition(async () => {
      try {
        await cancelMasterInventorySuspensionAction({
          suspensionId: protectionId,
          notes: 'Protección de saldo liberada desde el control operativo de Máster.',
        });
        setProtectionSuccess(`Protección #${protectionId} liberada.`);
        router.refresh();
      } catch (submissionError) {
        setProtectionError(submissionError instanceof Error ? submissionError.message : 'No se pudo liberar la protección.');
      } finally {
        setCancellingProtectionId(null);
      }
    });
  }

  function submitSuspension() {
    setSuspensionError(null);
    setSuspensionSuccess(null);
    const productId = Number(suspensionProductId);
    const inventoryItemId = Number(suspensionItemId);
    if (
      suspensionScope === 'product'
        ? (!Number.isSafeInteger(productId) || productId <= 0)
        : (!Number.isSafeInteger(inventoryItemId) || inventoryItemId <= 0)
    ) {
      setSuspensionError('Selecciona el producto que se va a detener.');
      return;
    }
    if (!suspensionIndefinite && !suspensionAvailableFrom) {
      setSuspensionError('Indica cuándo se reanudarán las ventas o marca la suspensión como indefinida.');
      return;
    }

    startSuspensionTransition(async () => {
      try {
        const common = {
          operationId: crypto.randomUUID(),
          availableFrom: suspensionIndefinite ? null : new Date(suspensionAvailableFrom).toISOString(),
          notes: suspensionNotes,
        };
        const result = suspensionScope === 'product'
          ? await saveMasterInventoryProductSuspensionAction({ ...common, productId })
          : await saveMasterInventorySuspensionAction({ ...common, inventoryItemId });
        setSuspensionSuccess(`Suspensión #${result.suspensionId} activada.`);
        setSuspensionProductId('');
        setSuspensionItemId('');
        setSuspensionIndefinite(false);
        setSuspensionAvailableFrom('');
        setSuspensionNotes('');
        router.refresh();
      } catch (submissionError) {
        setSuspensionError(submissionError instanceof Error ? submissionError.message : 'No se pudo suspender la disponibilidad comercial.');
      }
    });
  }

  function cancelSuspension(suspensionId: number) {
    if (!window.confirm('¿Reanudar las ventas de este producto desde ahora?')) return;
    setSuspensionError(null);
    setSuspensionSuccess(null);
    setCancellingSuspensionId(suspensionId);
    startSuspensionTransition(async () => {
      try {
        await cancelMasterInventorySuspensionAction({
          suspensionId,
          notes: 'Ventas reanudadas desde el control operativo de Máster.',
        });
        setSuspensionSuccess(`Suspensión #${suspensionId} finalizada.`);
        router.refresh();
      } catch (submissionError) {
        setSuspensionError(submissionError instanceof Error ? submissionError.message : 'No se pudo reanudar la disponibilidad comercial.');
      } finally {
        setCancellingSuspensionId(null);
      }
    });
  }

  return (
    <section className="space-y-5">
      <div className="flex flex-col gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/5 p-4 text-sm leading-6 text-emerald-100 sm:flex-row sm:items-center sm:justify-between">
        <span>Esta vista se carga solamente al abrir Inventario. Solicitar o revisar un conteo no bloquea pedidos ni descuenta productos.</span>
        <button type="button" disabled={isRefreshing} onClick={() => startRefresh(() => router.refresh())} className="shrink-0 rounded-xl border border-emerald-300/30 px-3 py-2 text-xs font-bold disabled:opacity-50">
          {isRefreshing ? 'Actualizando…' : 'Actualizar saldos'}
        </button>
      </div>

      <nav aria-label="Secciones del inventario de Máster" className="flex gap-2 overflow-x-auto rounded-2xl border border-[#292938] bg-[#111117] p-2">
        {([
          ['overview', 'Resumen'],
          ['stock', 'Existencias'],
          ['supplies', 'Entradas esperadas'],
          ['counts', 'Revisar inventarios'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={activeView === key}
            onClick={() => showView(key)}
            className={`shrink-0 rounded-xl px-4 py-2.5 text-sm font-bold transition ${activeView === key ? 'bg-[#FEEF00] text-black' : 'text-[#B8B8C4] hover:bg-[#1A1A23] hover:text-white'}`}
          >
            <span className="flex items-center gap-2">
              {label}
              {key === 'counts' && waitingMaster.length > 0 ? (
                <span className={`rounded-full px-2 py-0.5 text-[10px] tabular-nums ${activeView === key ? 'bg-black/15 text-black' : 'bg-rose-400/20 text-rose-100'}`}>
                  {waitingMaster.length}
                </span>
              ) : null}
            </span>
          </button>
        ))}
      </nav>

      {waitingMaster.length ? (
        <section id="inventory-reviews" className="scroll-mt-4 rounded-2xl border border-rose-300/45 bg-rose-400/10 p-4 shadow-[0_0_30px_rgba(251,113,133,0.08)] sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-xs font-black uppercase tracking-[0.16em] text-rose-200">Decisión pendiente</div>
              <h2 className="mt-1 text-xl font-black text-white">
                {waitingMaster.length} inventario{waitingMaster.length === 1 ? '' : 's'} cargado{waitingMaster.length === 1 ? '' : 's'} por Cocina
              </h2>
              <p className="mt-1 text-sm leading-6 text-[#D8B8BE]">Revisa las diferencias, acepta el conteo o solicita reconteos específicos.</p>
            </div>
            <Link
              href={`/app/inventory/counts/${waitingMaster[0].id}`}
              prefetch={false}
              className="shrink-0 rounded-xl bg-rose-200 px-4 py-2.5 text-center text-sm font-black text-rose-950 hover:bg-rose-100"
            >
              Revisar ahora
            </Link>
          </div>
          {waitingMaster.length > 1 ? (
            <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {waitingMaster.slice(0, 6).map((count) => (
                <Link
                  key={count.id}
                  href={`/app/inventory/counts/${count.id}`}
                  prefetch={false}
                  className="rounded-xl border border-rose-200/20 bg-[#170E12] p-3 transition hover:border-rose-200/45"
                >
                  <div className="font-bold text-white">{inventoryCountTitle({ countKind: count.countKind, createdAt: count.createdAt, shiftBusinessDate: count.shiftBusinessDate })}</div>
                  <div className="mt-1 text-xs text-[#C5A5AB]">{inventoryCountFolio(count.id)} · {countItemSummary(count)}</div>
                </Link>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard label="Ítems operativos" value={items.length} detail={dependsOnIncomingCount ? `${dependsOnIncomingCount} dependen de reposición` : 'sin dependencia de reposición'} tone={dependsOnIncomingCount ? 'warning' : 'default'} />
        <SummaryCard label="Esperando a Cocina" value={waitingKitchen.length} detail="solicitudes abiertas" tone={waitingKitchen.length ? 'warning' : 'default'} />
        <SummaryCard label="Esperando a Máster" value={waitingMaster.length} detail="reportes por decidir" tone={waitingMaster.length ? 'danger' : 'default'} />
        <SummaryCard label="Stock bajo" value={lowStockCount} detail="según umbral configurado" tone={lowStockCount ? 'warning' : 'default'} />
        <SummaryCard label="Ventas protegidas" value={protections.length} detail="hasta agotar saldo" tone={protections.length ? 'warning' : 'default'} />
      </div>

      {activeView === 'overview' ? (
        <div className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-amber-100">Atención del Máster</h2>
                <p className="mt-1 text-sm leading-6 text-[#BFB18C]">Solo decisiones operativas vigentes, sin duplicar avisos informativos.</p>
              </div>
              <Link href="/app/inventory/alerts" prefetch={false} className="shrink-0 text-xs font-bold text-amber-200 hover:underline">Ver centro</Link>
            </div>
            <div className="mt-4 space-y-2">
              {alerts.length ? alerts.map((alert) => (
                <article key={alert.id} className={`rounded-xl border p-3 ${alert.severity === 'critical' ? 'border-rose-400/30 bg-rose-400/5' : 'border-amber-300/20 bg-[#15130D]'}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">{alert.title}</div>
                      {alert.message ? <p className="mt-1 text-xs leading-5 text-[#B8B1A0]">{alert.message}</p> : null}
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black ${alert.severity === 'critical' ? 'bg-rose-400/15 text-rose-200' : 'bg-amber-300/15 text-amber-100'}`}>
                      {alert.severity === 'critical' ? 'CRÍTICA' : 'ATENCIÓN'}
                    </span>
                  </div>
                </article>
              )) : (
                <div className="rounded-xl border border-dashed border-emerald-300/20 px-4 py-5 text-sm text-emerald-100">No hay decisiones de inventario pendientes para Máster.</div>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">Productos que conviene revisar</h2>
                <p className="mt-1 text-sm leading-6 text-[#A6A6B2]">Ordenados por riesgo de compromisos, reposición y umbral.</p>
              </div>
              <button type="button" onClick={() => showView('stock')} className="shrink-0 text-xs font-bold text-[#FEEF00] hover:underline">Ver todos</button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {attentionItems.length ? attentionItems.map((item) => (
                <article key={item.id} className="rounded-xl border border-[#30303F] bg-[#0D0D12] p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-white">{item.name}</div>
                      <div className="mt-1 text-xs text-[#8F8F9C]">{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</div>
                    </div>
                    <span className={`shrink-0 text-sm font-black ${inventoryValueClass(item.availableWithoutIncomingUnits, item.dependsOnIncoming)}`}>
                      {item.availableWithoutIncomingUnits == null ? '—' : formatQuantity(item.availableWithoutIncomingUnits)}
                    </span>
                  </div>
                  <div className="mt-2 text-xs leading-5 text-[#A6A6B2]">
                    {item.dependsOnIncoming
                      ? 'Este saldo depende de una entrada o producción esperada.'
                      : item.commitmentUnits > 0
                        ? `${formatQuantity(item.commitmentUnits)} ${item.unitName} comprometidos.`
                        : 'Está dentro o por debajo del umbral configurado.'}
                  </div>
                </article>
              )) : (
                <div className="sm:col-span-2 rounded-xl border border-dashed border-emerald-300/20 px-4 py-5 text-sm text-emerald-100">No hay existencias en riesgo dentro del horizonte.</div>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {activeView === 'supplies' ? (
        <section id="master-expected-receipts" className="scroll-mt-4 rounded-2xl border border-violet-400/25 bg-violet-400/5 p-4 sm:p-5">
          <div>
            <h2 className="text-lg font-bold text-violet-100">Registrar una entrada esperada</h2>
            <p className="mt-1 text-sm leading-6 text-[#B4AAC5]">Es una proyección para decidir pedidos futuros. Cocina confirmará después lo que realmente llegó.</p>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <label className="text-sm text-[#C5C5CE] xl:col-span-2">Producto o insumo
              <select value={receiptItemId} onChange={(event) => setReceiptItemId(event.target.value)} className={`mt-1 ${inputClass}`}>
                <option value="">Seleccionar</option>
                {[...items].sort((left, right) => left.name.localeCompare(right.name, 'es')).map((item) => (
                  <option key={item.id} value={item.id}>{item.name} · {item.unitName}</option>
                ))}
              </select>
            </label>
            <label className="text-sm text-[#C5C5CE]">Fecha y hora estimada
              <input type="datetime-local" value={receiptEffectiveAt} onChange={(event) => setReceiptEffectiveAt(event.target.value)} className={`mt-1 ${inputClass}`} />
            </label>
            <label className="text-sm text-[#C5C5CE]">Cantidad en unidad base
              <input type="number" min="0.001" step="0.001" disabled={receiptQuantityUnknown} value={receiptQuantity} onChange={(event) => setReceiptQuantity(event.target.value)} className={`mt-1 ${inputClass} disabled:opacity-45`} placeholder="Ej. 500" />
            </label>
            <label className="text-sm text-[#C5C5CE]">Fuente opcional
              <input value={receiptSource} onChange={(event) => setReceiptSource(event.target.value)} maxLength={160} className={`mt-1 ${inputClass}`} placeholder="Ej. Fábrica" />
            </label>
            <label className="flex items-center gap-2 text-sm text-[#C5C5CE] md:col-span-2">
              <input type="checkbox" checked={receiptQuantityUnknown} onChange={(event) => setReceiptQuantityUnknown(event.target.checked)} className="h-4 w-4 accent-violet-300" />
              La cantidad todavía está por confirmar
            </label>
            <label className="text-sm text-[#C5C5CE] md:col-span-2 xl:col-span-3">Nota opcional
              <input value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} maxLength={1000} className={`mt-1 ${inputClass}`} placeholder="Detalle útil para Cocina o para la decisión del pedido" />
            </label>
          </div>
          {receiptError ? <div className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 p-3 text-sm text-rose-100">{receiptError}</div> : null}
          {receiptSuccess ? <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{receiptSuccess}</div> : null}
          <div className="mt-4 flex justify-end">
            <button type="button" disabled={isSavingReceipt} onClick={submitExpectedReceipt} className="rounded-xl bg-violet-200 px-4 py-2.5 text-sm font-black text-violet-950 disabled:cursor-not-allowed disabled:opacity-50">
              {isSavingReceipt ? 'Guardando…' : 'Registrar lo que viene'}
            </button>
          </div>
        </section>
      ) : null}

      {activeView === 'overview' ? (
        <section className="rounded-2xl border border-amber-300/30 bg-amber-300/5 p-4 sm:p-5">
          <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            <div>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold text-amber-100">Vender solo hasta agotar el saldo</h2>
                  <p className="mt-1 text-sm leading-6 text-[#C9BB91]">
                    Protege lo que realmente queda, descuenta primero del crudo y usa prefritos como respaldo.
                    Al agotarse ambas fuentes, Asesor y Counter no podrán agregar más para fechas anteriores a la reposición.
                  </p>
                </div>
                <span className="rounded-full border border-amber-200/25 px-2.5 py-1 text-[10px] font-black text-amber-100">
                  DECISIÓN DE MÁSTER
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <label className="text-sm text-[#D5CBAE] sm:col-span-2">Familia que se está agotando
                  <select
                    value={protectionItemId}
                    onChange={(event) => {
                      setProtectionItemId(event.target.value);
                      setProtectionExpectedFlowId('');
                    }}
                    className={`mt-1 ${inputClass}`}
                  >
                    <option value="">Seleccionar familia</option>
                    {families.map((family) => (
                      <option key={family.primaryInventoryItemId} value={family.primaryInventoryItemId}>
                        {family.productName} · {family.primaryItemName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-[#D5CBAE]">Reposición confirmada
                  <select
                    value={protectionExpectedFlowId}
                    onChange={(event) => setProtectionExpectedFlowId(event.target.value)}
                    disabled={!selectedProtectionFamily}
                    className={`mt-1 ${inputClass} disabled:opacity-45`}
                  >
                    <option value="">Sin fecha confirmada</option>
                    {protectionReceipts.map((receipt) => (
                      <option key={receipt.id} value={receipt.id}>
                        {formatDate(receipt.effectiveAt)} · +{formatQuantity(receipt.quantityUnits)} {receipt.unitName}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-sm text-[#D5CBAE]">Reserva por seguridad ({selectedProtectionFamily?.primaryUnitName ?? 'UND'})
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={protectionReserve}
                    onChange={(event) => setProtectionReserve(event.target.value)}
                    className={`mt-1 ${inputClass}`}
                    placeholder="Ej. 10"
                  />
                </label>

                {selectedProtectionFamily ? (
                  <div className="sm:col-span-2 rounded-xl border border-amber-200/15 bg-black/20 p-3 text-xs leading-5 text-[#CFC5A7]">
                    <span className="font-bold text-amber-100">Respaldo:</span>{' '}
                    {selectedProtectionFamily.fallbackItemName}. Cada servicio prefrito cubre{' '}
                    {formatQuantity(selectedProtectionFamily.rawUnitsPerPrefriedUnit)} UND de la familia frita.
                    {!protectionReceipts.length ? ' Registra primero una entrada esperada si ya conoces la reposición.' : ''}
                  </div>
                ) : null}

                <label className="text-sm text-[#D5CBAE] sm:col-span-2">Nota opcional
                  <input
                    value={protectionNotes}
                    onChange={(event) => setProtectionNotes(event.target.value)}
                    maxLength={1000}
                    className={`mt-1 ${inputClass}`}
                    placeholder="Ej. Reservar 10 UND por posibles averías"
                  />
                </label>
              </div>

              {protectionError ? <div className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 p-3 text-sm text-rose-100">{protectionError}</div> : null}
              {protectionSuccess ? <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{protectionSuccess}</div> : null}
              <div className="mt-4 flex justify-end">
                <button
                  type="button"
                  disabled={isSavingProtection || !families.length}
                  onClick={submitProtection}
                  className="rounded-xl bg-amber-200 px-4 py-2.5 text-sm font-black text-amber-950 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSavingProtection ? 'Activando…' : 'Vender solo hasta agotar'}
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white">Protecciones activas</h3>
                  <p className="mt-1 text-xs leading-5 text-[#AFA582]">
                    No cancelan pedidos. Si un conteo reduce el saldo, Máster recibirá la alerta de compromisos en riesgo.
                  </p>
                </div>
                <span className="rounded-full border border-amber-200/25 px-2.5 py-1 text-xs text-amber-100">{protections.length}</span>
              </div>
              <div className="mt-4 space-y-2">
                {protections.length ? protections.map((protection) => (
                  <article key={protection.id} className="rounded-xl border border-amber-200/20 bg-[#17140B] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-white">{protection.primaryItemName}</div>
                        <div className="mt-1 text-xs text-amber-100">
                          Reserva: {formatQuantity(protection.safetyReserveUnits)} {protection.primaryUnitName}
                        </div>
                        <div className="mt-1 text-xs text-[#B8AD8D]">Respaldo: {protection.fallbackItemName}</div>
                        <div className="mt-1 text-xs font-semibold text-sky-200">
                          {protection.availableFrom ? `Reposición: ${formatDate(protection.availableFrom)}` : 'Reposición sin fecha confirmada'}
                        </div>
                        {protection.notes ? <p className="mt-2 text-xs leading-5 text-[#AFA582]">{protection.notes}</p> : null}
                      </div>
                      <button
                        type="button"
                        disabled={isSavingProtection}
                        onClick={() => cancelProtection(protection.id)}
                        className="shrink-0 text-xs font-black text-emerald-200 hover:underline disabled:opacity-45"
                      >
                        {cancellingProtectionId === protection.id ? 'Liberando…' : 'Liberar'}
                      </button>
                    </div>
                  </article>
                )) : (
                  <div className="rounded-xl border border-dashed border-amber-200/20 px-4 py-5 text-sm text-[#C9BB91]">
                    No hay familias vendiéndose bajo saldo protegido.
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeView === 'overview' ? (
        <section className="rounded-2xl border border-rose-400/25 bg-rose-400/5 p-4 sm:p-5">
          <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
            <div>
              <h2 className="text-lg font-bold text-rose-100">Detener ventas temporalmente</h2>
              <p className="mt-1 text-sm leading-6 text-[#C7A8AE]">
                Detener un producto también detiene los combos que lo llevan fijo. Si es seleccionable,
                solo se deshabilita esa opción. No cambia el stock ni cancela pedidos ya creados.
              </p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div className="flex gap-2 sm:col-span-2">
                  <button
                    type="button"
                    onClick={() => setSuspensionScope('product')}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold ${suspensionScope === 'product' ? 'border-rose-200 bg-rose-200 text-rose-950' : 'border-rose-300/25 text-rose-100'}`}
                  >
                    Producto del catálogo
                  </button>
                  <button
                    type="button"
                    onClick={() => setSuspensionScope('inventory_item')}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold ${suspensionScope === 'inventory_item' ? 'border-rose-200 bg-rose-200 text-rose-950' : 'border-rose-300/25 text-rose-100'}`}
                  >
                    Insumo físico
                  </button>
                </div>
                {suspensionScope === 'product' ? (
                  <label className="text-sm text-[#D1C2C5] sm:col-span-2">Producto que dejará de venderse
                    <select value={suspensionProductId} onChange={(event) => setSuspensionProductId(event.target.value)} className={`mt-1 ${inputClass}`}>
                      <option value="">Seleccionar producto</option>
                      {products.map((product) => (
                        <option key={product.id} value={product.id}>{product.name}{product.sku ? ` · ${product.sku}` : ''}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <label className="text-sm text-[#D1C2C5] sm:col-span-2">Insumo físico que detendrá todos sus consumidores
                    <select value={suspensionItemId} onChange={(event) => setSuspensionItemId(event.target.value)} className={`mt-1 ${inputClass}`}>
                      <option value="">Seleccionar insumo</option>
                      {[...items].sort((left, right) => left.name.localeCompare(right.name, 'es')).map((item) => (
                        <option key={item.id} value={item.id}>{item.name}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="text-sm text-[#D1C2C5]">Disponible nuevamente
                  <input type="datetime-local" disabled={suspensionIndefinite} value={suspensionAvailableFrom} onChange={(event) => setSuspensionAvailableFrom(event.target.value)} className={`mt-1 ${inputClass} disabled:opacity-45`} />
                </label>
                <label className="flex items-end gap-2 pb-2 text-sm text-[#D1C2C5]">
                  <input type="checkbox" checked={suspensionIndefinite} onChange={(event) => setSuspensionIndefinite(event.target.checked)} className="h-4 w-4 accent-rose-300" />
                  Sin fecha definida
                </label>
                <label className="text-sm text-[#D1C2C5] sm:col-span-2">Nota opcional
                  <input value={suspensionNotes} onChange={(event) => setSuspensionNotes(event.target.value)} maxLength={1000} className={`mt-1 ${inputClass}`} placeholder="Ej. Fábrica confirmó reposición para el jueves" />
                </label>
              </div>
              {suspensionError ? <div className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 p-3 text-sm text-rose-100">{suspensionError}</div> : null}
              {suspensionSuccess ? <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">{suspensionSuccess}</div> : null}
              <div className="mt-4 flex justify-end">
                <button type="button" disabled={isSavingSuspension} onClick={submitSuspension} className="rounded-xl bg-rose-200 px-4 py-2.5 text-sm font-black text-rose-950 disabled:cursor-not-allowed disabled:opacity-50">
                  {isSavingSuspension ? 'Guardando…' : 'Detener ventas'}
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="font-bold text-white">Suspensiones activas</h3>
                  <p className="mt-1 text-xs leading-5 text-[#A99196]">Al llegar la fecha indicada, la lectura vuelve a permitir el producto automáticamente.</p>
                </div>
                <span className="rounded-full border border-rose-300/25 px-2.5 py-1 text-xs text-rose-100">{suspensions.length}</span>
              </div>
              <div className="mt-4 space-y-2">
                {suspensions.length ? suspensions.map((suspension) => (
                  <article key={suspension.id} className="rounded-xl border border-rose-300/20 bg-[#160D11] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-semibold text-white">{suspension.itemName}</div>
                        <div className="mt-1 text-[10px] font-black uppercase tracking-wide text-[#A99196]">
                          {suspension.scope === 'product' ? 'Producto del catálogo' : 'Insumo físico'}
                        </div>
                        <div className="mt-1 text-xs font-semibold text-rose-200">
                          {suspension.availableFrom ? `Hasta ${formatDate(suspension.availableFrom)}` : 'Sin fecha de reanudación'}
                        </div>
                        {suspension.notes ? <p className="mt-2 text-xs leading-5 text-[#AD969B]">{suspension.notes}</p> : null}
                      </div>
                      <button
                        type="button"
                        disabled={isSavingSuspension}
                        onClick={() => cancelSuspension(suspension.id)}
                        className="shrink-0 text-xs font-black text-emerald-200 hover:underline disabled:opacity-45"
                      >
                        {cancellingSuspensionId === suspension.id ? 'Reanudando…' : 'Reanudar ahora'}
                      </button>
                    </div>
                  </article>
                )) : (
                  <div className="rounded-xl border border-dashed border-emerald-300/20 px-4 py-5 text-sm text-emerald-100">No hay ventas detenidas por Máster.</div>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {activeView === 'supplies' ? (
      <div className="rounded-2xl border border-sky-400/25 bg-sky-400/5 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-sky-100">Suministros próximos</h2>
            <p className="mt-1 text-sm leading-6 text-[#A8BBC8]">
              Entradas y producciones activas incluidas en la proyección de los próximos 10 días. Todavía no son existencia física.
            </p>
          </div>
          <span className="rounded-full border border-sky-300/25 px-3 py-1.5 text-xs font-bold text-sky-100">
            {supplies.length} programada{supplies.length === 1 ? '' : 's'}
          </span>
        </div>

        {supplies.length ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {supplies.slice(0, 12).map((supply) => (
              <article key={supply.id} className="rounded-xl border border-sky-300/20 bg-[#0B1118] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-white">{supply.itemName}</div>
                    <div className="mt-1 text-xs text-[#93A8B8]">{formatDate(supply.effectiveAt)}</div>
                  </div>
                  <span className="shrink-0 rounded-full border border-sky-300/25 px-2 py-1 text-[10px] font-semibold text-sky-100">
                    {supply.type === 'expected_receipt' ? 'ENTRADA' : 'PRODUCCIÓN'}
                  </span>
                </div>
                <div className="mt-3 text-lg font-black text-sky-100">+{formatQuantity(supply.quantityUnits)} {supply.unitName}</div>
                <div className="mt-1 text-xs font-semibold text-amber-200">
                  {supply.type === 'expected_receipt' ? 'Programada · no recibida' : 'Planificada · no disponible'}
                </div>
                {supply.sourceName ? <div className="mt-2 text-xs text-[#A6B5C1]">Origen: {supply.sourceName}</div> : null}
                {!supply.sourceName && supply.recipeId ? <div className="mt-2 text-xs text-[#A6B5C1]">Receta #{supply.recipeId}</div> : null}
                {supply.notes ? <div className="mt-1 line-clamp-2 text-xs text-[#8395A3]">{supply.notes}</div> : null}
                {supply.type === 'expected_receipt' ? (
                  <button
                    type="button"
                    disabled={isSavingReceipt}
                    onClick={() => cancelExpectedReceipt(supply.id)}
                    className="mt-3 text-xs font-bold text-rose-200 hover:underline disabled:opacity-45"
                  >
                    {cancellingSupplyId === supply.id ? 'Cancelando…' : 'Cancelar expectativa'}
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-sky-300/20 px-4 py-5 text-sm text-[#93A8B8]">
            No hay entradas ni producciones activas dentro de los próximos 10 días.
          </div>
        )}

        {supplies.length > 12 ? <div className="mt-3 text-xs text-[#93A8B8]">Mostrando las 12 entradas o producciones más próximas.</div> : null}
      </div>
      ) : null}

      <div className="space-y-5">
        {activeView === 'counts' ? (
        <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Solicitar conteo a Cocina</h2>
              <p className="mt-1 text-sm leading-6 text-[#A6A6B2]">Cocina no verá el saldo esperado. Si no indicas límite, vencerá en 30 minutos.</p>
            </div>
            <span className="rounded-full border border-[#343444] px-3 py-1 text-xs text-[#C7C7D0]">{selectedIds.length} seleccionados</span>
          </div>

          <div className="mt-4 flex gap-2">
            <input aria-label="Buscar ítems para solicitar conteo" value={search} onChange={(event) => setSearch(event.target.value)} className={inputClass} placeholder="Buscar producto o grupo" />
            <button type="button" onClick={selectVisible} className="shrink-0 rounded-xl border border-[#3A3A49] px-3 text-xs font-semibold hover:border-[#FEEF00]/60">Seleccionar visibles</button>
          </div>

          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Filtrar conteo por familia">
            {['all', ...availableGroups].map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => setRequestGroup(group)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${requestGroup === group ? 'border-[#FEEF00] bg-[#FEEF00] text-black' : 'border-[#343444] text-[#B8B8C4]'}`}
              >
                {group === 'all' ? 'Todos' : groupLabels[group] ?? group}
              </button>
            ))}
          </div>

          <div className="mt-3 max-h-[340px] space-y-2 overflow-y-auto pr-1">
            {selectableItems.map((item) => {
              const selected = selectedIds.includes(item.id);
              const disabled = item.pendingCountId != null;
              return (
                <label key={item.id} className={`flex items-start gap-3 rounded-xl border p-3 ${disabled ? 'cursor-not-allowed border-[#242433] opacity-55' : selected ? 'border-[#FEEF00]/55 bg-[#FEEF00]/5' : 'border-[#292938] bg-[#0D0D12]'}`}>
                  <input type="checkbox" checked={selected} disabled={disabled} onChange={() => toggleItem(item.id)} className="mt-1 h-4 w-4 accent-[#FEEF00]" />
                  <span className="flex min-w-0 flex-1 items-start justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block font-semibold">{item.name}</span>
                      <span className="mt-0.5 block text-xs text-[#92929F]">{groupLabels[item.inventoryGroup] ?? item.inventoryGroup}</span>
                      {disabled ? <span className="mt-1 block text-xs text-amber-300">Ya está en {inventoryCountFolio(item.pendingCountId!)}</span> : null}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[10px] font-bold uppercase tracking-wide text-[#777784]">Sistema</span>
                      <span className="mt-0.5 block font-black text-white">{formatQuantity(item.currentStockUnits)} {item.unitName}</span>
                    </span>
                  </span>
                </label>
              );
            })}
          </div>

          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-[#C5C5CE]">Fecha límite
              <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} className={`mt-1 ${inputClass}`} />
            </label>
            <label className="text-sm text-[#C5C5CE] sm:col-span-2">Nota opcional
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} className={`mt-1 ${inputClass}`} placeholder="Ej. Recontar bolsas y unidades sueltas de mandocas" />
            </label>
          </div>

          {error ? <div className="mt-3 rounded-xl border border-rose-400/35 bg-rose-400/10 p-3 text-sm text-rose-100">{error}</div> : null}
          {createdCountId ? (
            <div className="mt-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-3 text-sm text-emerald-100">
              {inventoryCountFolio(createdCountId)} enviado a Cocina. <Link href={`/app/inventory/counts/${createdCountId}`} prefetch={false} className="font-bold underline">Abrir registro</Link>
            </div>
          ) : null}

          <div className="mt-4 flex justify-end">
            <button type="button" disabled={isPending || !selectedIds.length} onClick={submitRequest} className="rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-black text-black disabled:cursor-not-allowed disabled:opacity-45">
              {isPending ? 'Enviando…' : 'Solicitar conteo'}
            </button>
          </div>
        </div>
        ) : null}

        {activeView === 'stock' ? (
        <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-bold">Saldo del sistema</h2>
              <p className="mt-1 text-sm text-[#A6A6B2]">Existencias y pedidos separados por familia.</p>
            </div>
            <input aria-label="Buscar en el saldo del sistema" value={stockSearch} onChange={(event) => setStockSearch(event.target.value)} className={`${inputClass} sm:max-w-xs`} placeholder="Buscar existencia" />
          </div>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1" aria-label="Filtrar existencias por familia">
            {['all', ...availableGroups].map((group) => (
              <button
                key={group}
                type="button"
                onClick={() => setStockGroup(group)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-bold ${stockGroup === group ? 'border-[#FEEF00] bg-[#FEEF00] text-black' : 'border-[#343444] text-[#B8B8C4]'}`}
              >
                {group === 'all' ? 'Todos' : groupLabels[group] ?? group}
              </button>
            ))}
          </div>

          <div className="mt-4 max-h-[640px] space-y-4 overflow-auto pr-1">
            {stockSections.map((section) => (
              <section key={section.group} className="overflow-hidden rounded-xl border border-[#292938]">
                <div className="sticky top-0 z-10 flex items-center justify-between bg-[#1A1A23] px-4 py-2.5">
                  <h3 className="font-black text-white">{section.label}</h3>
                  <span className="text-xs text-[#92929F]">{section.items.length}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[920px] text-left text-sm">
                    <thead className="bg-[#14141B] text-[10px] uppercase tracking-wide text-[#858591]">
                      <tr>
                        <th className="px-4 py-2">Producto</th>
                        <th className="px-4 py-2 text-right">Sistema</th>
                        <th className="px-4 py-2 text-right">Pedidos 10 días</th>
                        <th className="px-4 py-2 text-right">Pedidos &gt;10 días</th>
                        <th className="px-4 py-2 text-right">Libre 10 días</th>
                        <th className="px-4 py-2 text-right">Con entradas</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#242433]">
                      {section.items.map((item) => (
                        <tr key={item.id} className={item.isLowStock ? 'bg-amber-400/5' : 'bg-[#101015]'}>
                          <td className="px-4 py-2.5">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-white">{item.name}</span>
                              {item.isLowStock ? <span className="rounded-full bg-amber-300/10 px-2 py-0.5 text-[10px] font-black text-amber-300">BAJO</span> : null}
                              {item.pendingCountId ? <Link href={`/app/inventory/counts/${item.pendingCountId}`} prefetch={false} className="rounded-full bg-sky-300/10 px-2 py-0.5 text-[10px] font-black text-sky-200">EN CONTEO</Link> : null}
                            </div>
                            <div className="mt-1 text-[11px] text-[#777784]">
                              {item.lastCountedAt ? `${item.lastCountAgeText} · ${item.lastCountedByName ?? 'Sin responsable'}` : 'Sin conteo físico'}
                              {item.lowStockThreshold == null ? '' : ` · Mín. ${formatQuantity(item.lowStockThreshold)} ${item.unitName}`}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right font-black text-white">{formatQuantity(item.currentStockUnits)} <span className="text-[11px] font-normal text-[#858591]">{item.unitName}</span></td>
                          <td className="px-4 py-2.5 text-right text-violet-200">{formatQuantity(item.commitmentUnits)} <span className="text-[11px] text-[#858591]">{item.unitName}</span></td>
                          <td className="px-4 py-2.5 text-right text-[#B8B8C4]">{formatQuantity(item.laterCommitmentUnits)} <span className="text-[11px] text-[#858591]">{item.unitName}</span></td>
                          <td className={`px-4 py-2.5 text-right font-black ${inventoryValueClass(item.availableWithoutIncomingUnits)}`}>{item.availableWithoutIncomingUnits == null ? '—' : `${formatQuantity(item.availableWithoutIncomingUnits)} ${item.unitName}`}</td>
                          <td className={`px-4 py-2.5 text-right font-black ${inventoryValueClass(item.projectedAvailableUnits, item.dependsOnIncoming)}`}>
                            {item.projectedAvailableUnits == null ? '—' : `${formatQuantity(item.projectedAvailableUnits)} ${item.unitName}`}
                            {item.dependsOnIncoming ? <div className="text-[10px] font-semibold text-amber-300">USA REPOSICIÓN</div> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
            {stockSections.length === 0 ? <div className="rounded-xl border border-dashed border-[#343444] p-6 text-center text-sm text-[#858591]">No hay productos para este filtro.</div> : null}
          </div>
          <p className="mt-3 text-xs leading-5 text-[#858591]">
            Libre 10 días: lo que queda después de los pedidos próximos, sin sumar reposiciones. Con entradas: proyección que sí suma las entradas y producciones esperadas.
          </p>
        </div>
        ) : null}
      </div>

      {activeView === 'counts' && waitingKitchen.length ? (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 p-4 sm:p-5">
          <h2 className="text-lg font-bold text-amber-100">Conteos que debe responder Cocina</h2>
          <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {waitingKitchen.map((count) => <CountCard key={count.id} count={count} actionLabel="Ver solicitud" />)}
          </div>
        </div>
      ) : null}

      {activeView === 'counts' ? (
      <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-lg font-bold">Actividad reciente</h2><p className="mt-1 text-sm text-[#92929F]">Trazabilidad resumida; el detalle conserva cada diferencia y decisión.</p></div>
          <Link href="/app/inventory/counts" prefetch={false} className="text-sm font-semibold text-[#FEEF00] hover:underline">Ver todo</Link>
        </div>
        <div className="mt-4 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {recentCounts.length ? recentCounts.map((count) => <CountCard key={count.id} count={count} actionLabel="Abrir reporte" />) : <div className="text-sm text-[#8F8F9C]">Todavía no hay actividad cerrada.</div>}
        </div>
      </div>
      ) : null}
    </section>
  );
}

function SummaryCard({ label, value, detail, tone = 'default' }: { label: string; value: number; detail: string; tone?: 'default' | 'warning' | 'danger' }) {
  const valueClass = tone === 'danger' ? 'text-rose-300' : tone === 'warning' ? 'text-amber-300' : 'text-white';
  return <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4"><div className="text-xs uppercase tracking-wide text-[#8F8F9C]">{label}</div><div className={`mt-2 text-3xl font-black ${valueClass}`}>{value}</div><div className="mt-1 text-xs text-[#858591]">{detail}</div></div>;
}

function CountCard({ count, actionLabel }: { count: MasterInventoryCount; actionLabel: string }) {
  return (
    <article className="rounded-xl border border-[#30303F] bg-[#111117] p-4">
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-xs uppercase tracking-wide text-[#90909D]">{countKindLabels[count.countKind] ?? count.countKind}</div><h3 className="mt-1 font-bold">{inventoryCountTitle({ countKind: count.countKind, createdAt: count.createdAt, shiftBusinessDate: count.shiftBusinessDate })}</h3></div>
        <span className="rounded-full border border-[#3A3A49] px-2.5 py-1 text-[11px] text-[#D0D0D8]">{statusLabels[count.status] ?? count.status}</span>
      </div>
      <p className="mt-3 text-sm leading-5 text-[#B5B5C0]">{countItemSummary(count)}</p>
      <div className="mt-2 text-xs text-[#858591]">{inventoryCountFolio(count.id)} · {count.lineCount} ítems · {count.varianceCount} diferencias · {count.status === 'open' ? `vence ${formatDate(count.dueAt)}` : formatDate(count.submittedAt ?? count.reviewedAt ?? count.createdAt)}</div>
      {count.notes ? <p className="mt-2 line-clamp-2 text-xs leading-5 text-[#A6A6B2]">{count.notes}</p> : null}
      <Link href={`/app/inventory/counts/${count.id}`} prefetch={false} className="mt-3 inline-flex text-sm font-bold text-[#FEEF00] hover:underline">{actionLabel} →</Link>
    </article>
  );
}
