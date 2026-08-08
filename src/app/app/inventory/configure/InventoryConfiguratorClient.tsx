'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import { saveInventoryCatalogDraftAction } from '../actions';

export type ConfiguratorInventoryItem = {
  id: number;
  name: string;
  unitName: string;
  trackingMode: 'transactional' | 'periodic_count' | 'not_tracked' | null;
  isActive: boolean;
};

export type ConfiguratorProduct = {
  id: number;
  sku: string | null;
  name: string;
  type: 'product' | 'combo' | 'service' | 'promo' | 'gambit';
  isActive: boolean;
  sourcePriceAmount: number;
  sourcePriceCurrency: 'USD' | 'VES';
  unitsPerService: number;
  allowsHalfService: boolean;
  isTemporary: boolean;
  detailUnitsLimit: number;
  inventoryPolicy: 'self' | 'direct' | 'components' | 'none' | null;
};

type EntryKind = 'item' | 'product';
type InventoryPolicy = 'self' | 'direct' | 'components' | 'none';
type ItemDraft = {
  name: string;
  inventoryKind: 'raw_material' | 'prepared_base' | 'finished_stock' | 'packaging';
  inventoryGroup: 'raw' | 'fried' | 'prefried' | 'sauces' | 'packaging' | 'other';
  unitName: string;
  trackingMode: 'transactional' | 'periodic_count' | 'not_tracked';
  availabilityMode: '' | 'on_hand_only' | 'immediate_recipe' | 'scheduled_recipe';
  consumptionTriggers: string[];
  lowStockThreshold: string;
  targetStockUnits: string;
  shelfLifeDays: string;
  primaryCountFrequency: '' | 'per_shift' | 'daily' | 'weekly' | 'biweekly' | 'monthly';
  primaryCountRole: '' | 'admin' | 'master' | 'kitchen' | 'counter';
  notes: string;
};
type PresentationDraft = {
  key: string;
  name: string;
  baseUnits: string;
  allowsFractionalQuantity: boolean;
};
type DirectLinkDraft = {
  key: string;
  inventoryItemId: string;
  quantityUnits: string;
  deductionStage: '' | 'kitchen' | 'production' | 'packing' | 'fulfillment';
};
type ComponentDraft = {
  key: string;
  componentProductId: string;
  componentMode: 'fixed' | 'selectable';
  quantity: string;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
};

const inputClass =
  'w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';

function emptyItemDraft(): ItemDraft {
  return {
    name: '',
    inventoryKind: 'finished_stock',
    inventoryGroup: 'other',
    unitName: 'pieza',
    trackingMode: 'transactional',
    availabilityMode: 'on_hand_only',
    consumptionTriggers: ['sale'],
    lowStockThreshold: '',
    targetStockUnits: '',
    shelfLifeDays: '',
    primaryCountFrequency: '',
    primaryCountRole: '',
    notes: '',
  };
}

function optionalNumber(value: string) {
  return value.trim() ? parseDecimalInput(value) : null;
}

function itemPayload(item: ItemDraft) {
  return {
    name: item.name.trim(),
    inventory_kind: item.inventoryKind,
    inventory_group: item.inventoryGroup,
    unit_name: item.unitName.trim(),
    tracking_mode: item.trackingMode,
    availability_mode: item.availabilityMode || null,
    consumption_triggers: item.consumptionTriggers,
    low_stock_threshold: optionalNumber(item.lowStockThreshold),
    target_stock_units: optionalNumber(item.targetStockUnits),
    shelf_life_days: optionalNumber(item.shelfLifeDays),
    primary_count_frequency: item.primaryCountFrequency || null,
    primary_count_role: item.primaryCountRole || null,
    notes: item.notes.trim() || null,
  };
}

function presentationsPayload(presentations: PresentationDraft[]) {
  return presentations.map((presentation) => ({
    name: presentation.name.trim(),
    base_units: optionalNumber(presentation.baseUnits),
    allows_fractional_quantity: presentation.allowsFractionalQuantity,
  }));
}

function createKey() {
  return crypto.randomUUID();
}

export default function InventoryConfiguratorClient({
  inventoryItems,
  products,
}: {
  inventoryItems: ConfiguratorInventoryItem[];
  products: ConfiguratorProduct[];
}) {
  const router = useRouter();
  const [entryKind, setEntryKind] = useState<EntryKind>('product');
  const [item, setItem] = useState<ItemDraft>(emptyItemDraft);
  const [presentations, setPresentations] = useState<PresentationDraft[]>([]);
  const [reuseProductId, setReuseProductId] = useState('');
  const [productName, setProductName] = useState('');
  const [sku, setSku] = useState('');
  const [productType, setProductType] = useState<ConfiguratorProduct['type']>('product');
  const [sourcePriceAmount, setSourcePriceAmount] = useState('0');
  const [sourcePriceCurrency, setSourcePriceCurrency] = useState<'USD' | 'VES'>('USD');
  const [unitsPerService, setUnitsPerService] = useState('0');
  const [allowsHalfService, setAllowsHalfService] = useState(false);
  const [isTemporary, setIsTemporary] = useState(false);
  const [policy, setPolicy] = useState<InventoryPolicy>('self');
  const [noneReason, setNoneReason] = useState('');
  const [selfItemMode, setSelfItemMode] = useState<'existing' | 'new'>('existing');
  const [selfInventoryItemId, setSelfInventoryItemId] = useState('');
  const [selfQuantity, setSelfQuantity] = useState('1');
  const [selfDeductionStage, setSelfDeductionStage] = useState<DirectLinkDraft['deductionStage']>('fulfillment');
  const [directLinks, setDirectLinks] = useState<DirectLinkDraft[]>([]);
  const [components, setComponents] = useState<ComponentDraft[]>([]);
  const [detailUnitsLimit, setDetailUnitsLimit] = useState('0');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{
    entryKind: EntryKind;
    productId: number | null;
    inventoryItemId: number | null;
    reusedProduct: boolean;
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const reusableProducts = useMemo(
    () => products.filter((product) => !product.isActive),
    [products],
  );
  const hasSelectableComponents = components.some(
    (component) => component.componentMode === 'selectable',
  );

  function resetForm(nextEntryKind = entryKind) {
    setItem(emptyItemDraft());
    setPresentations([]);
    setReuseProductId('');
    setProductName('');
    setSku('');
    setProductType('product');
    setSourcePriceAmount('0');
    setSourcePriceCurrency('USD');
    setUnitsPerService('0');
    setAllowsHalfService(false);
    setIsTemporary(false);
    setPolicy('self');
    setNoneReason('');
    setSelfItemMode('existing');
    setSelfInventoryItemId('');
    setSelfQuantity('1');
    setSelfDeductionStage('fulfillment');
    setDirectLinks([]);
    setComponents([]);
    setDetailUnitsLimit('0');
    setError(null);
    setSuccess(null);
    setEntryKind(nextEntryKind);
  }

  function selectReusableProduct(value: string) {
    setReuseProductId(value);
    if (!value) return;
    const selectedProduct = reusableProducts.find((product) => product.id === Number(value));
    if (!selectedProduct) return;

    setProductName(selectedProduct.name);
    setSku(selectedProduct.sku ?? '');
    setProductType(selectedProduct.type);
    setSourcePriceAmount(String(selectedProduct.sourcePriceAmount));
    setSourcePriceCurrency(selectedProduct.sourcePriceCurrency);
    setUnitsPerService(String(selectedProduct.unitsPerService));
    setAllowsHalfService(selectedProduct.allowsHalfService);
    setIsTemporary(selectedProduct.isTemporary);
    setDetailUnitsLimit(String(selectedProduct.detailUnitsLimit));
    if (selectedProduct.inventoryPolicy) setPolicy(selectedProduct.inventoryPolicy);
  }

  function validateBeforeSubmit() {
    if (entryKind === 'item') {
      if (!item.name.trim()) return 'Escribe el nombre del ítem interno.';
      if (!item.unitName.trim()) return 'Escribe la unidad base del ítem.';
      return null;
    }

    if (!productName.trim()) return 'Escribe el nombre del producto.';
    if (!sku.trim()) return 'Escribe el SKU del producto.';
    if (policy === 'self') {
      if (selfItemMode === 'existing' && !selfInventoryItemId) {
        return 'Selecciona el ítem físico que representa al producto.';
      }
      if (selfItemMode === 'new' && !item.name.trim() && !productName.trim()) {
        return 'Escribe el nombre del nuevo ítem físico.';
      }
    }
    if (policy === 'direct' && directLinks.length === 0) {
      return 'Agrega al menos un ítem de consumo directo.';
    }
    if (policy === 'components' && components.length === 0) {
      return 'Agrega al menos un producto componente.';
    }
    if (policy === 'components' && hasSelectableComponents && Number(detailUnitsLimit) <= 0) {
      return 'Define el límite de unidades seleccionables.';
    }
    if (policy === 'none' && noneReason.trim().length < 3) {
      return 'Explica por qué este producto no descuenta inventario.';
    }
    return null;
  }

  function handleSubmit() {
    setError(null);
    setSuccess(null);
    const validationError = validateBeforeSubmit();
    if (validationError) {
      setError(validationError);
      return;
    }

    let configuration: Record<string, unknown>;
    if (entryKind === 'item') {
      configuration = {
        entry_kind: 'item',
        inventory_item: itemPayload(item),
        presentations: presentationsPayload(presentations),
      };
    } else {
      configuration = {
        entry_kind: 'product',
        product_id: reuseProductId ? Number(reuseProductId) : null,
        product: {
          name: productName.trim(),
          sku: sku.trim().toUpperCase(),
          type: productType,
          source_price_amount: optionalNumber(sourcePriceAmount) ?? 0,
          source_price_currency: sourcePriceCurrency,
          units_per_service: optionalNumber(unitsPerService) ?? 0,
          allows_half_service: allowsHalfService,
          is_temporary: isTemporary,
          detail_units_limit: optionalNumber(detailUnitsLimit) ?? 0,
          inventory_policy: policy,
          none_reason: noneReason.trim() || null,
        },
      };

      if (policy === 'self') {
        configuration.self_item =
          selfItemMode === 'existing'
            ? {
                mode: 'existing',
                inventory_item_id: Number(selfInventoryItemId),
                quantity_units: optionalNumber(selfQuantity),
                deduction_stage: selfDeductionStage || null,
              }
            : {
                mode: 'new',
                inventory_item: itemPayload({
                  ...item,
                  name: item.name.trim() || productName.trim(),
                }),
                presentations: presentationsPayload(presentations),
                quantity_units: optionalNumber(selfQuantity),
                deduction_stage: selfDeductionStage || null,
              };
      } else if (policy === 'direct') {
        configuration.links = directLinks.map((link) => ({
          inventory_item_id: Number(link.inventoryItemId),
          quantity_units: optionalNumber(link.quantityUnits),
          deduction_stage: link.deductionStage || null,
        }));
      } else if (policy === 'components') {
        configuration.components = components.map((component) => ({
          component_product_id: Number(component.componentProductId),
          component_mode: component.componentMode,
          quantity: optionalNumber(component.quantity),
          counts_toward_detail_limit: component.countsTowardDetailLimit,
          is_required: component.isRequired,
        }));
      }
    }

    startTransition(async () => {
      try {
        const result = await saveInventoryCatalogDraftAction({ configuration });
        setSuccess(result);
        router.refresh();
      } catch (submissionError) {
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : 'No se pudo guardar el borrador.',
        );
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Configurador universal</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#9696A3]">
            Crea identidades y reglas canónicas sin activar existencias ni descuentos. Cada resultado
            queda como borrador inactivo hasta su validación y apertura incremental.
          </p>
        </div>
        <span className="rounded-full border border-amber-400/30 bg-amber-400/5 px-3 py-1 text-xs font-semibold text-amber-200">
          Solo Administración · Borradores seguros
        </span>
      </section>

      <section className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <ModeButton
            active={entryKind === 'product'}
            title="Producto comercial"
            description="Se vende y define self, direct, components o none."
            onClick={() => resetForm('product')}
          />
          <ModeButton
            active={entryKind === 'item'}
            title="Ítem físico interno"
            description="Materia, preparación, empaque o consumible controlado."
            onClick={() => resetForm('item')}
          />
        </div>
      </section>

      {entryKind === 'product' ? (
        <>
          <Section title="1. Identidad comercial" description="Puedes crear una identidad nueva o reutilizar una inactiva sin pedidos.">
            <Field label="Reutilizar producto inactivo (opcional)" hint="Supabase rechazará automáticamente cualquier producto con historia de pedidos o dependencias.">
              <select
                value={reuseProductId}
                onChange={(event) => selectReusableProduct(event.target.value)}
                disabled={isPending}
                className={inputClass}
              >
                <option value="">Crear producto nuevo</option>
                {reusableProducts.map((product) => (
                  <option key={product.id} value={product.id}>
                    #{product.id} · {product.name} · {product.sku ?? 'sin SKU'}
                  </option>
                ))}
              </select>
            </Field>

            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <Field label="Nombre">
                <input value={productName} onChange={(event) => setProductName(event.target.value)} disabled={isPending} maxLength={160} className={inputClass} />
              </Field>
              <Field label="SKU">
                <input value={sku} onChange={(event) => setSku(event.target.value.toUpperCase())} disabled={isPending} maxLength={64} placeholder="EJEMPLO-001" className={inputClass} />
              </Field>
              <Field label="Tipo comercial">
                <select value={productType} onChange={(event) => setProductType(event.target.value as ConfiguratorProduct['type'])} disabled={isPending} className={inputClass}>
                  <option value="product">Producto</option>
                  <option value="combo">Combo</option>
                  <option value="service">Servicio</option>
                  <option value="promo">Promoción</option>
                  <option value="gambit">Gambit</option>
                </select>
              </Field>
              <div className="grid grid-cols-[1fr_110px] gap-2">
                <Field label="Precio fuente">
                  <input type="number" min="0" step="0.01" value={sourcePriceAmount} onChange={(event) => setSourcePriceAmount(event.target.value)} disabled={isPending} className={inputClass} />
                </Field>
                <Field label="Moneda">
                  <select value={sourcePriceCurrency} onChange={(event) => setSourcePriceCurrency(event.target.value as 'USD' | 'VES')} disabled={isPending} className={inputClass}>
                    <option value="USD">USD</option>
                    <option value="VES">VES</option>
                  </select>
                </Field>
              </div>
              <Field label="Unidades por servicio">
                <input type="number" min="0" step="1" value={unitsPerService} onChange={(event) => setUnitsPerService(event.target.value)} disabled={isPending} className={inputClass} />
              </Field>
              <div className="flex flex-wrap items-center gap-5 pt-7 text-sm text-[#D2D2DA]">
                <Checkbox checked={allowsHalfService} onChange={setAllowsHalfService} disabled={isPending} label="Admite medio servicio" />
                <Checkbox checked={isTemporary} onChange={setIsTemporary} disabled={isPending} label="Producto temporal" />
              </div>
            </div>
          </Section>

          <Section title="2. Política de inventario" description="Esta elección define la única ruta canónica de consumo del producto.">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {([
                ['self', 'Se descuenta a sí mismo'],
                ['direct', 'Descuenta ítems físicos'],
                ['components', 'Descompone productos'],
                ['none', 'No descuenta inventario'],
              ] as const).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={policy === value}
                  onClick={() => setPolicy(value)}
                  disabled={isPending}
                  className={`rounded-xl border px-3 py-3 text-left text-sm transition ${
                    policy === value
                      ? 'border-[#FEEF00]/70 bg-[#FEEF00]/10 text-[#FEEF00]'
                      : 'border-[#30303F] bg-[#0D0D12] text-[#C4C4CD] hover:border-[#5A5A68]'
                  }`}
                >
                  <span className="block font-semibold uppercase">{value}</span>
                  <span className="mt-1 block text-xs opacity-75">{label}</span>
                </button>
              ))}
            </div>

            <div className="mt-5">
              {policy === 'self' ? (
                <SelfPolicyEditor
                  mode={selfItemMode}
                  setMode={setSelfItemMode}
                  inventoryItems={inventoryItems}
                  inventoryItemId={selfInventoryItemId}
                  setInventoryItemId={setSelfInventoryItemId}
                  quantity={selfQuantity}
                  setQuantity={setSelfQuantity}
                  deductionStage={selfDeductionStage}
                  setDeductionStage={setSelfDeductionStage}
                  item={item}
                  setItem={setItem}
                  presentations={presentations}
                  setPresentations={setPresentations}
                  disabled={isPending}
                />
              ) : null}
              {policy === 'direct' ? (
                <DirectPolicyEditor
                  rows={directLinks}
                  setRows={setDirectLinks}
                  inventoryItems={inventoryItems}
                  disabled={isPending}
                />
              ) : null}
              {policy === 'components' ? (
                <ComponentsPolicyEditor
                  rows={components}
                  setRows={setComponents}
                  products={products}
                  reusedProductId={reuseProductId}
                  detailUnitsLimit={detailUnitsLimit}
                  setDetailUnitsLimit={setDetailUnitsLimit}
                  disabled={isPending}
                />
              ) : null}
              {policy === 'none' ? (
                <Field label="Razón" hint="Ejemplo: servicio logístico que aparece en la orden pero no representa una existencia física.">
                  <textarea value={noneReason} onChange={(event) => setNoneReason(event.target.value)} disabled={isPending} rows={3} maxLength={300} className={inputClass} />
                </Field>
              ) : null}
            </div>
          </Section>
        </>
      ) : (
        <Section title="Ítem físico interno" description="La existencia inicia en cero y el ítem queda inactivo; no altera la apertura actual.">
          <ItemEditor item={item} setItem={setItem} disabled={isPending} />
          <PresentationsEditor presentations={presentations} setPresentations={setPresentations} disabled={isPending} />
        </Section>
      )}

      <section className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <div className="rounded-xl border border-sky-400/25 bg-sky-400/5 px-4 py-3 text-sm leading-6 text-sky-100/85">
          Guardar no activa el producto, no cambia stock y no conecta descuentos. La activación exigirá
          validación canónica y, cuando corresponda, conteo físico inicial.
        </div>

        {error ? <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-200">{error}</div> : null}
        {success ? (
          <div role="status" className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-100">
            Borrador guardado. {success.productId ? `Producto #${success.productId}. ` : ''}
            {success.inventoryItemId ? `Ítem #${success.inventoryItemId}. ` : ''}
            {success.reusedProduct ? 'Se reutilizó la identidad seleccionada.' : 'Se creó una identidad nueva.'}
            <div className="mt-2 flex gap-3 text-xs font-semibold">
              <Link href="/app/inventory/products" prefetch={false} className="text-[#FEEF00]">Ver productos</Link>
              <Link href="/app/inventory" prefetch={false} className="text-[#FEEF00]">Ver ítems</Link>
            </div>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => resetForm()} disabled={isPending} className="rounded-xl border border-[#343444] px-4 py-2.5 text-sm text-[#B9B9C4] disabled:opacity-50">
            Limpiar
          </button>
          <button type="button" onClick={handleSubmit} disabled={isPending} className="rounded-xl bg-[#FEEF00] px-5 py-2.5 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-50">
            {isPending ? 'Guardando…' : 'Guardar borrador seguro'}
          </button>
        </div>
      </section>
    </div>
  );
}

function ModeButton({ active, title, description, onClick }: { active: boolean; title: string; description: string; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={`rounded-xl border p-4 text-left ${active ? 'border-[#FEEF00]/70 bg-[#FEEF00]/10' : 'border-[#30303F] bg-[#0D0D12]'}`}>
      <span className={`block font-semibold ${active ? 'text-[#FEEF00]' : 'text-white'}`}>{title}</span>
      <span className="mt-1 block text-xs text-[#9696A3]">{description}</span>
    </button>
  );
}

function Section({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[#8F8F9C]">{description}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-2 block text-[#BDBDC7]">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs leading-5 text-[#777784]">{hint}</span> : null}
    </label>
  );
}

function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (value: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className="flex items-center gap-2">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} disabled={disabled} className="h-4 w-4 accent-[#FEEF00]" />
      <span>{label}</span>
    </label>
  );
}

function ItemEditor({ item, setItem, disabled }: { item: ItemDraft; setItem: React.Dispatch<React.SetStateAction<ItemDraft>>; disabled: boolean }) {
  function update<K extends keyof ItemDraft>(key: K, value: ItemDraft[K]) {
    setItem((current) => ({ ...current, [key]: value }));
  }

  function toggleTrigger(trigger: string, checked: boolean) {
    setItem((current) => ({
      ...current,
      consumptionTriggers: checked
        ? Array.from(new Set([...current.consumptionTriggers, trigger]))
        : current.consumptionTriggers.filter((value) => value !== trigger),
    }));
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Field label="Nombre físico"><input value={item.name} onChange={(event) => update('name', event.target.value)} disabled={disabled} maxLength={160} className={inputClass} /></Field>
        <Field label="Unidad base"><input value={item.unitName} onChange={(event) => update('unitName', event.target.value)} disabled={disabled} maxLength={40} placeholder="pieza, kg, envase" className={inputClass} /></Field>
        <Field label="Tipo físico">
          <select value={item.inventoryKind} onChange={(event) => update('inventoryKind', event.target.value as ItemDraft['inventoryKind'])} disabled={disabled} className={inputClass}>
            <option value="raw_material">Materia prima</option><option value="prepared_base">Base preparada</option><option value="finished_stock">Stock terminado</option><option value="packaging">Empaque/consumible</option>
          </select>
        </Field>
        <Field label="Grupo">
          <select value={item.inventoryGroup} onChange={(event) => update('inventoryGroup', event.target.value as ItemDraft['inventoryGroup'])} disabled={disabled} className={inputClass}>
            <option value="raw">Crudo</option><option value="fried">Frito</option><option value="prefried">Prefrito</option><option value="sauces">Salsas</option><option value="packaging">Empaque</option><option value="other">Otro</option>
          </select>
        </Field>
        <Field label="Modo de control">
          <select value={item.trackingMode} onChange={(event) => update('trackingMode', event.target.value as ItemDraft['trackingMode'])} disabled={disabled} className={inputClass}>
            <option value="transactional">Transaccional</option><option value="periodic_count">Conteo periódico</option><option value="not_tracked">No controlado</option>
          </select>
        </Field>
        <Field label="Disponibilidad">
          <select value={item.availabilityMode} onChange={(event) => update('availabilityMode', event.target.value as ItemDraft['availabilityMode'])} disabled={disabled || item.trackingMode === 'not_tracked'} className={inputClass}>
            <option value="">No aplica</option><option value="on_hand_only">Solo existencia real</option><option value="immediate_recipe">Preparación inmediata</option><option value="scheduled_recipe">Preparación programada</option>
          </select>
        </Field>
      </div>

      <div className="rounded-xl border border-[#2A2A38] bg-[#0D0D12] p-4">
        <div className="text-sm text-[#BDBDC7]">Se consume por</div>
        <div className="mt-3 flex flex-wrap gap-5 text-sm text-[#D0D0D8]">
          <Checkbox checked={item.consumptionTriggers.includes('sale')} onChange={(value) => toggleTrigger('sale', value)} disabled={disabled || item.trackingMode === 'not_tracked'} label="Venta" />
          <Checkbox checked={item.consumptionTriggers.includes('production')} onChange={(value) => toggleTrigger('production', value)} disabled={disabled || item.trackingMode === 'not_tracked'} label="Producción" />
          <Checkbox checked={item.consumptionTriggers.includes('manual_issue')} onChange={(value) => toggleTrigger('manual_issue', value)} disabled={disabled || item.trackingMode === 'not_tracked'} label="Salida manual" />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Field label="Alerta desde"><input type="number" min="0" step="0.01" value={item.lowStockThreshold} onChange={(event) => update('lowStockThreshold', event.target.value)} disabled={disabled} className={inputClass} /></Field>
        <Field label="Stock objetivo"><input type="number" min="0" step="0.01" value={item.targetStockUnits} onChange={(event) => update('targetStockUnits', event.target.value)} disabled={disabled} className={inputClass} /></Field>
        <Field label="Vida útil (días)"><input type="number" min="0" step="1" value={item.shelfLifeDays} onChange={(event) => update('shelfLifeDays', event.target.value)} disabled={disabled} className={inputClass} /></Field>
        <Field label="Frecuencia principal">
          <select value={item.primaryCountFrequency} onChange={(event) => update('primaryCountFrequency', event.target.value as ItemDraft['primaryCountFrequency'])} disabled={disabled} className={inputClass}>
            <option value="">Sin definir</option><option value="per_shift">Por turno</option><option value="daily">Diaria</option><option value="weekly">Semanal</option><option value="biweekly">Quincenal</option><option value="monthly">Mensual</option>
          </select>
        </Field>
        <Field label="Responsable principal">
          <select value={item.primaryCountRole} onChange={(event) => update('primaryCountRole', event.target.value as ItemDraft['primaryCountRole'])} disabled={disabled} className={inputClass}>
            <option value="">Sin definir</option><option value="kitchen">Cocina</option><option value="master">Máster</option><option value="counter">Counter</option><option value="admin">Administración</option>
          </select>
        </Field>
        <Field label="Nota"><input value={item.notes} onChange={(event) => update('notes', event.target.value)} disabled={disabled} maxLength={1000} className={inputClass} /></Field>
      </div>
    </div>
  );
}

function PresentationsEditor({ presentations, setPresentations, disabled }: { presentations: PresentationDraft[]; setPresentations: React.Dispatch<React.SetStateAction<PresentationDraft[]>>; disabled: boolean }) {
  return (
    <div className="mt-5 rounded-xl border border-[#2A2A38] bg-[#0D0D12] p-4">
      <div className="flex items-center justify-between gap-3">
        <div><div className="font-semibold">Presentaciones de entrada</div><div className="mt-1 text-xs text-[#7F7F8C]">Ejemplo: bolsa = 200 piezas. Siempre también se admiten unidades individuales.</div></div>
        <button type="button" onClick={() => setPresentations((current) => [...current, { key: createKey(), name: '', baseUnits: '', allowsFractionalQuantity: false }])} disabled={disabled || presentations.length >= 20} className="rounded-lg border border-[#41414F] px-3 py-2 text-xs text-[#FEEF00] disabled:opacity-40">Agregar</button>
      </div>
      <div className="mt-4 space-y-3">
        {presentations.map((presentation) => (
          <div key={presentation.key} className="grid gap-2 md:grid-cols-[1fr_180px_180px_auto] md:items-center">
            <input aria-label="Nombre de presentación" value={presentation.name} onChange={(event) => setPresentations((current) => current.map((row) => row.key === presentation.key ? { ...row, name: event.target.value } : row))} disabled={disabled} placeholder="Bolsa, caja, galón" className={inputClass} />
            <input aria-label="Unidades base por presentación" type="number" min="0.0001" step="0.01" value={presentation.baseUnits} onChange={(event) => setPresentations((current) => current.map((row) => row.key === presentation.key ? { ...row, baseUnits: event.target.value } : row))} disabled={disabled} placeholder="Unidades base" className={inputClass} />
            <Checkbox checked={presentation.allowsFractionalQuantity} onChange={(value) => setPresentations((current) => current.map((row) => row.key === presentation.key ? { ...row, allowsFractionalQuantity: value } : row))} disabled={disabled} label="Admite fracción" />
            <button type="button" onClick={() => setPresentations((current) => current.filter((row) => row.key !== presentation.key))} disabled={disabled} className="rounded-lg border border-red-400/25 px-3 py-2 text-xs text-red-200">Quitar</button>
          </div>
        ))}
        {presentations.length === 0 ? <div className="text-xs text-[#70707D]">Sin presentaciones adicionales.</div> : null}
      </div>
    </div>
  );
}

function SelfPolicyEditor({ mode, setMode, inventoryItems, inventoryItemId, setInventoryItemId, quantity, setQuantity, deductionStage, setDeductionStage, item, setItem, presentations, setPresentations, disabled }: { mode: 'existing' | 'new'; setMode: (value: 'existing' | 'new') => void; inventoryItems: ConfiguratorInventoryItem[]; inventoryItemId: string; setInventoryItemId: (value: string) => void; quantity: string; setQuantity: (value: string) => void; deductionStage: DirectLinkDraft['deductionStage']; setDeductionStage: (value: DirectLinkDraft['deductionStage']) => void; item: ItemDraft; setItem: React.Dispatch<React.SetStateAction<ItemDraft>>; presentations: PresentationDraft[]; setPresentations: React.Dispatch<React.SetStateAction<PresentationDraft[]>>; disabled: boolean }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => setMode('existing')} disabled={disabled} className={`rounded-lg border px-3 py-2 text-sm ${mode === 'existing' ? 'border-[#FEEF00]/60 text-[#FEEF00]' : 'border-[#343444] text-[#AAAAB5]'}`}>Reutilizar ítem</button>
        <button type="button" onClick={() => setMode('new')} disabled={disabled} className={`rounded-lg border px-3 py-2 text-sm ${mode === 'new' ? 'border-[#FEEF00]/60 text-[#FEEF00]' : 'border-[#343444] text-[#AAAAB5]'}`}>Crear ítem físico</button>
      </div>
      {mode === 'existing' ? (
        <Field label="Ítem físico canónico">
          <select value={inventoryItemId} onChange={(event) => setInventoryItemId(event.target.value)} disabled={disabled} className={inputClass}>
            <option value="">Seleccionar</option>{inventoryItems.map((inventoryItem) => <option key={inventoryItem.id} value={inventoryItem.id}>{inventoryItem.name} · {inventoryItem.unitName} · {inventoryItem.isActive ? 'activo' : 'borrador'}</option>)}
          </select>
        </Field>
      ) : (
        <><ItemEditor item={item} setItem={setItem} disabled={disabled} /><PresentationsEditor presentations={presentations} setPresentations={setPresentations} disabled={disabled} /></>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Cantidad por producto vendido"><input type="number" min="0.0001" step="0.01" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={disabled} className={inputClass} /></Field>
        <Field label="Etapa del descuento"><StageSelect value={deductionStage} onChange={setDeductionStage} disabled={disabled} /></Field>
      </div>
    </div>
  );
}

function DirectPolicyEditor({ rows, setRows, inventoryItems, disabled }: { rows: DirectLinkDraft[]; setRows: React.Dispatch<React.SetStateAction<DirectLinkDraft[]>>; inventoryItems: ConfiguratorInventoryItem[]; disabled: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between"><div className="text-sm text-[#AFAFBA]">Ítems físicos consumidos por una unidad vendida</div><button type="button" onClick={() => setRows((current) => [...current, { key: createKey(), inventoryItemId: '', quantityUnits: '1', deductionStage: 'kitchen' }])} disabled={disabled || rows.length >= 50} className="rounded-lg border border-[#41414F] px-3 py-2 text-xs text-[#FEEF00]">Agregar ítem</button></div>
      <div className="mt-4 space-y-3">{rows.map((row) => <div key={row.key} className="grid gap-2 lg:grid-cols-[1fr_180px_200px_auto]"><select aria-label="Ítem de consumo" value={row.inventoryItemId} onChange={(event) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, inventoryItemId: event.target.value } : candidate))} disabled={disabled} className={inputClass}><option value="">Seleccionar ítem</option>{inventoryItems.map((inventoryItem) => <option key={inventoryItem.id} value={inventoryItem.id}>{inventoryItem.name} · {inventoryItem.unitName}</option>)}</select><input aria-label="Cantidad consumida" type="number" min="0.0001" step="0.01" value={row.quantityUnits} onChange={(event) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, quantityUnits: event.target.value } : candidate))} disabled={disabled} className={inputClass} /><StageSelect value={row.deductionStage} onChange={(value) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, deductionStage: value } : candidate))} disabled={disabled} /><button type="button" onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))} disabled={disabled} className="rounded-lg border border-red-400/25 px-3 py-2 text-xs text-red-200">Quitar</button></div>)}</div>
    </div>
  );
}

function ComponentsPolicyEditor({ rows, setRows, products, reusedProductId, detailUnitsLimit, setDetailUnitsLimit, disabled }: { rows: ComponentDraft[]; setRows: React.Dispatch<React.SetStateAction<ComponentDraft[]>>; products: ConfiguratorProduct[]; reusedProductId: string; detailUnitsLimit: string; setDetailUnitsLimit: (value: string) => void; disabled: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-3"><div className="text-sm text-[#AFAFBA]">Productos fijos o seleccionables que forman la venta</div><button type="button" onClick={() => setRows((current) => [...current, { key: createKey(), componentProductId: '', componentMode: 'fixed', quantity: '1', countsTowardDetailLimit: true, isRequired: true }])} disabled={disabled || rows.length >= 100} className="rounded-lg border border-[#41414F] px-3 py-2 text-xs text-[#FEEF00]">Agregar componente</button></div>
      <div className="mt-4 space-y-3">{rows.map((row) => <div key={row.key} className="rounded-xl border border-[#2D2D3B] bg-[#0D0D12] p-3"><div className="grid gap-2 lg:grid-cols-[1fr_150px_150px_auto]"><select aria-label="Producto componente" value={row.componentProductId} onChange={(event) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, componentProductId: event.target.value } : candidate))} disabled={disabled} className={inputClass}><option value="">Seleccionar producto</option>{products.filter((product) => String(product.id) !== reusedProductId).map((product) => <option key={product.id} value={product.id}>{product.name} · {product.sku ?? `#${product.id}`}</option>)}</select><select aria-label="Modo del componente" value={row.componentMode} onChange={(event) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, componentMode: event.target.value as ComponentDraft['componentMode'], isRequired: event.target.value === 'fixed' } : candidate))} disabled={disabled} className={inputClass}><option value="fixed">Fijo</option><option value="selectable">Seleccionable</option></select><input aria-label="Cantidad del componente" type="number" min="0.0001" step="0.01" value={row.quantity} onChange={(event) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, quantity: event.target.value } : candidate))} disabled={disabled} className={inputClass} /><button type="button" onClick={() => setRows((current) => current.filter((candidate) => candidate.key !== row.key))} disabled={disabled} className="rounded-lg border border-red-400/25 px-3 py-2 text-xs text-red-200">Quitar</button></div><div className="mt-3 flex flex-wrap gap-5 text-sm text-[#B8B8C2]"><Checkbox checked={row.countsTowardDetailLimit} onChange={(value) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, countsTowardDetailLimit: value } : candidate))} disabled={disabled} label="Cuenta para el límite" /><Checkbox checked={row.isRequired} onChange={(value) => setRows((current) => current.map((candidate) => candidate.key === row.key ? { ...candidate, isRequired: value } : candidate))} disabled={disabled} label="Obligatorio" /></div></div>)}</div>
      {rows.some((row) => row.componentMode === 'selectable') ? <div className="mt-4 max-w-sm"><Field label="Límite de unidades seleccionables"><input type="number" min="1" step="1" value={detailUnitsLimit} onChange={(event) => setDetailUnitsLimit(event.target.value)} disabled={disabled} className={inputClass} /></Field></div> : null}
    </div>
  );
}

function StageSelect({ value, onChange, disabled }: { value: DirectLinkDraft['deductionStage']; onChange: (value: DirectLinkDraft['deductionStage']) => void; disabled: boolean }) {
  return <select value={value} onChange={(event) => onChange(event.target.value as DirectLinkDraft['deductionStage'])} disabled={disabled} className={inputClass}><option value="">Sin etapa</option><option value="kitchen">Cocina</option><option value="production">Producción</option><option value="packing">Empaque</option><option value="fulfillment">Entrega/cumplimiento</option></select>;
}
