'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMemo, useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import {
  activateInventoryRecipeAction,
  saveInventoryRecipeDraftAction,
  updateInventoryItemControlsAction,
  updateInventoryProductIdentityAction,
} from '../actions';

type ProductLink = {
  inventory_item_id: number;
  item_name: string;
  quantity_units: number;
  deduction_mode: string;
  deduction_stage: string | null;
};

export type AdminProduct = {
  id: number;
  sku: string | null;
  name: string;
  type: string;
  is_active: boolean;
  units_per_service: number;
  allows_half_service: boolean;
  is_temporary: boolean;
  detail_units_limit: number;
  source_price_amount: number;
  source_price_currency: 'USD' | 'VES';
  commission_mode: 'default' | 'fixed_item' | 'fixed_order';
  commission_value: number | null;
  commission_notes: string | null;
  advisor_gift_cost_usd: number | null;
  internal_rider_pay_usd: number | null;
  inventory_policy: 'self' | 'direct' | 'components' | 'none' | null;
  inventory_configuration_status: string;
  order_reference_count: number;
  open_order_reference_count: number;
  parent_product_count: number;
  links: ProductLink[];
};

export type AdminItem = {
  id: number;
  name: string;
  inventory_kind: string;
  inventory_group: string;
  unit_name: string;
  tracking_mode: 'transactional' | 'periodic_count' | 'not_tracked' | null;
  availability_mode: 'on_hand_only' | 'immediate_recipe' | 'scheduled_recipe' | null;
  current_stock_units: number;
  low_stock_threshold: number | null;
  low_stock_inclusive: boolean;
  target_stock_units: number | null;
  shelf_life_days: number | null;
  primary_count_frequency: 'per_shift' | 'daily' | 'weekly' | 'biweekly' | 'monthly' | null;
  primary_count_role: 'admin' | 'master' | 'kitchen' | 'counter' | null;
  notes: string | null;
  is_active: boolean;
  has_accepted_opening: boolean;
  product_reference_count: number;
  recipe_input_count: number;
  recipe_output_count: number;
};

type RecipeComponent = {
  input_inventory_item_id: number;
  input_name: string;
  unit_name: string;
  quantity_units: number;
  current_stock_units: number;
};

export type AdminRecipe = {
  id: number;
  output_inventory_item_id: number;
  output_name: string;
  output_unit_name: string;
  recipe_kind: 'production' | 'packaging';
  output_quantity_units: number;
  lead_time_minutes: number;
  production_multiple: number;
  version: number;
  is_active: boolean;
  notes: string | null;
  lifecycle: 'active' | 'draft' | 'history';
  active_batch_count: number;
  activation_blockers: string[];
  components: RecipeComponent[];
};

export type InventoryAdminWorkspace = {
  products: AdminProduct[];
  items: AdminItem[];
  recipes: AdminRecipe[];
  rules: {
    product_structure_locked: boolean;
    item_structure_locked_after_creation: boolean;
    active_recipe_mutation_allowed: boolean;
    recipe_activation_is_explicit: boolean;
    orders_blocked_by_inventory: boolean;
  };
};

type Editor = 'product' | 'item' | 'recipe';
type RecipeLine = {
  key: string;
  inputInventoryItemId: string;
  quantityUnits: string;
};

const INPUT_CLASS =
  'w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';
const PRIMARY_BUTTON =
  'rounded-xl bg-[#FEEF00] px-4 py-2.5 text-sm font-bold text-black disabled:cursor-not-allowed disabled:opacity-40';
const SECONDARY_BUTTON =
  'rounded-xl border border-[#383847] bg-[#17171F] px-4 py-2.5 text-sm font-semibold text-[#D7D7DF] disabled:cursor-not-allowed disabled:opacity-40';

const policyLabels: Record<NonNullable<AdminProduct['inventory_policy']>, string> = {
  self: 'Se descuenta a sí mismo',
  direct: 'Consume ítems directos',
  components: 'Se resuelve por componentes',
  none: 'No descuenta inventario',
};

const availabilityLabels: Record<NonNullable<AdminItem['availability_mode']>, string> = {
  on_hand_only: 'Solo existencia física',
  immediate_recipe: 'Preparación inmediata',
  scheduled_recipe: 'Preparación con tiempo',
};

function quantity(value: unknown) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(Number(value ?? 0));
}

function optionalDecimal(value: string) {
  if (!value.trim()) return null;
  return parseDecimalInput(value);
}

function cleanRecipeNote(value: string | null) {
  return (value ?? '')
    .replace(/^Borrador administrador:\s*/i, '')
    .replace(/^Bloque 3:\s*/i, '')
    .replace(/^Histórico canónico:\s*/i, '')
    .replace(/^Histórico previo:\s*/i, '');
}

function recipeKey(outputItemId: number, kind: AdminRecipe['recipe_kind']) {
  return `${outputItemId}:${kind}`;
}

export default function InventoryAdministrationClient({
  workspace,
}: {
  workspace: InventoryAdminWorkspace;
}) {
  const [editor, setEditor] = useState<Editor>('product');
  const [productId, setProductId] = useState('');
  const [itemId, setItemId] = useState('');
  const [recipeOutputId, setRecipeOutputId] = useState('');
  const [recipeKind, setRecipeKind] = useState<AdminRecipe['recipe_kind']>('production');

  const product = workspace.products.find((candidate) => candidate.id === Number(productId));
  const item = workspace.items.find((candidate) => candidate.id === Number(itemId));
  const recipeOutputItem = workspace.items.find(
    (candidate) => candidate.id === Number(recipeOutputId),
  );
  const recipeVersions = workspace.recipes.filter(
    (recipe) =>
      recipe.output_inventory_item_id === Number(recipeOutputId) &&
      recipe.recipe_kind === recipeKind,
  );
  const activeRecipe = recipeVersions.find((recipe) => recipe.lifecycle === 'active') ?? null;
  const draftRecipe = recipeVersions.find((recipe) => recipe.lifecycle === 'draft') ?? null;

  return (
    <section className="rounded-2xl border border-[#2C2C3A] bg-[#101016] p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#FEEF00]">
            Administración segura
          </div>
          <h2 className="mt-1 text-xl font-semibold">Modificar lo existente</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9898A5]">
            Cada editor cambia una sola capa. Los nombres y controles se actualizan sin tocar
            existencias; las fórmulas generan una versión nueva y la receta vigente continúa
            operando hasta que actives el borrador.
          </p>
        </div>
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-3 text-xs leading-5 text-emerald-100">
          <div className="font-semibold">Órdenes sin bloqueo</div>
          <div>Estas modificaciones no impiden crear ni enviar órdenes.</div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <RuleCard number="1" title="Producto comercial">
          Identidad, precio, comisión y condiciones comerciales. No cambia descuentos físicos.
        </RuleCard>
        <RuleCard number="2" title="Ítem físico">
          Alertas, objetivo, conteo y disponibilidad. No cambia unidad, tipo ni saldo.
        </RuleCard>
        <RuleCard number="3" title="Receta versionada">
          Insumos, rendimiento y tiempo. Se compara y se activa explícitamente.
        </RuleCard>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Tipo de configuración">
        <EditorButton active={editor === 'product'} onClick={() => setEditor('product')}>
          Editar producto
        </EditorButton>
        <EditorButton active={editor === 'item'} onClick={() => setEditor('item')}>
          Editar ítem físico
        </EditorButton>
        <EditorButton active={editor === 'recipe'} onClick={() => setEditor('recipe')}>
          Versionar receta
        </EditorButton>
      </div>

      {editor === 'product' ? (
        <div className="mt-5">
          <Field label="Producto activo">
            <select
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Selecciona un producto…</option>
              {workspace.products.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.sku ?? 'sin SKU'}
                </option>
              ))}
            </select>
          </Field>
          {product ? <ProductEditor key={product.id} product={product} /> : <EmptyEditor />}
        </div>
      ) : null}

      {editor === 'item' ? (
        <div className="mt-5">
          <Field label="Ítem físico">
            <select
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
              className={INPUT_CLASS}
            >
              <option value="">Selecciona un ítem…</option>
              {workspace.items.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} · {candidate.is_active ? 'activo' : 'borrador'}
                </option>
              ))}
            </select>
          </Field>
          {item ? <ItemEditor key={item.id} item={item} /> : <EmptyEditor />}
        </div>
      ) : null}

      {editor === 'recipe' ? (
        <div className="mt-5">
          <div className="grid gap-3 md:grid-cols-[1fr_240px]">
            <Field label="Ítem que quedará producido">
              <select
                value={recipeOutputId}
                onChange={(event) => setRecipeOutputId(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Selecciona una salida…</option>
                {workspace.items
                  .filter((candidate) => candidate.tracking_mode === 'transactional')
                  .map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.unit_name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Tipo de transformación">
              <select
                value={recipeKind}
                onChange={(event) =>
                  setRecipeKind(event.target.value as AdminRecipe['recipe_kind'])
                }
                className={INPUT_CLASS}
              >
                <option value="production">Preparación / producción</option>
                <option value="packaging">Porcionado / envasado</option>
              </select>
            </Field>
          </div>
          {recipeOutputItem ? (
            <RecipeEditor
              key={recipeKey(recipeOutputItem.id, recipeKind)}
              outputItem={recipeOutputItem}
              items={workspace.items}
              kind={recipeKind}
              activeRecipe={activeRecipe}
              draftRecipe={draftRecipe}
              history={recipeVersions.filter((recipe) => recipe.lifecycle === 'history')}
            />
          ) : (
            <EmptyEditor />
          )}
        </div>
      ) : null}
    </section>
  );
}

function ProductEditor({ product }: { product: AdminProduct }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(product.name);
  const [sku, setSku] = useState(product.sku ?? '');
  const [unitsPerService, setUnitsPerService] = useState(String(product.units_per_service));
  const [detailUnitsLimit, setDetailUnitsLimit] = useState(String(product.detail_units_limit));
  const [allowsHalfService, setAllowsHalfService] = useState(product.allows_half_service);
  const [isTemporary, setIsTemporary] = useState(product.is_temporary);
  const [sourcePriceAmount, setSourcePriceAmount] = useState(String(product.source_price_amount));
  const [sourcePriceCurrency, setSourcePriceCurrency] = useState(product.source_price_currency);
  const [commissionMode, setCommissionMode] = useState(product.commission_mode);
  const [commissionValue, setCommissionValue] = useState(
    product.commission_value == null ? '' : String(product.commission_value),
  );
  const [commissionNotes, setCommissionNotes] = useState(product.commission_notes ?? '');
  const [advisorGiftCostUsd, setAdvisorGiftCostUsd] = useState(
    product.advisor_gift_cost_usd == null ? '' : String(product.advisor_gift_cost_usd),
  );
  const [internalRiderPayUsd, setInternalRiderPayUsd] = useState(
    product.internal_rider_pay_usd == null ? '' : String(product.internal_rider_pay_usd),
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        await updateInventoryProductIdentityAction({
          productId: product.id,
          name,
          sku,
          unitsPerService: Number(unitsPerService),
          detailUnitsLimit: Number(detailUnitsLimit),
          allowsHalfService,
          isTemporary,
          sourcePriceAmount: parseDecimalInput(sourcePriceAmount),
          sourcePriceCurrency,
          commissionMode,
          commissionValue:
            commissionMode === 'default' ? null : parseDecimalInput(commissionValue),
          commissionNotes: commissionNotes.trim() || null,
          advisorGiftCostUsd: optionalDecimal(advisorGiftCostUsd),
          internalRiderPayUsd: optionalDecimal(internalRiderPayUsd),
        });
        setMessage('Producto actualizado. Las órdenes históricas conservaron sus datos originales.');
        router.refresh();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'No se pudo modificar el producto.');
      }
    });
  }

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre comercial">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} className={INPUT_CLASS} />
          </Field>
          <Field label="SKU">
            <input value={sku} onChange={(event) => setSku(event.target.value)} maxLength={64} className={INPUT_CLASS} />
          </Field>
          <Field label="Piezas o unidades por servicio">
            <input type="number" min="0" step="1" value={unitsPerService} onChange={(event) => setUnitsPerService(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Límite de selección (solo productos flexibles)">
            <input type="number" min="0" step="1" value={detailUnitsLimit} onChange={(event) => setDetailUnitsLimit(event.target.value)} className={INPUT_CLASS} />
          </Field>
        </div>
        <div className="mt-4 flex flex-wrap gap-4">
          <Checkbox checked={allowsHalfService} onChange={setAllowsHalfService} label="Admite medio servicio" />
          <Checkbox checked={isTemporary} onChange={setIsTemporary} label="Producto temporal" />
        </div>
        <div className="mt-5 border-t border-[#2B2B38] pt-5">
          <div className="text-sm font-semibold text-[#E4E4EA]">Precio y condiciones comerciales</div>
          <p className="mt-1 text-xs leading-5 text-[#92929F]">
            Se guardan en el producto actual y no modifican su estructura física de inventario.
          </p>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="grid grid-cols-[1fr_100px] gap-2">
              <Field label="Precio fuente">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={sourcePriceAmount}
                  onChange={(event) => setSourcePriceAmount(event.target.value)}
                  className={INPUT_CLASS}
                />
              </Field>
              <Field label="Moneda">
                <select
                  value={sourcePriceCurrency}
                  onChange={(event) => setSourcePriceCurrency(event.target.value as 'USD' | 'VES')}
                  className={INPUT_CLASS}
                >
                  <option value="USD">USD</option>
                  <option value="VES">VES</option>
                </select>
              </Field>
            </div>
            <Field label="Comisión del asesor">
              <select
                value={commissionMode}
                onChange={(event) =>
                  setCommissionMode(
                    event.target.value as AdminProduct['commission_mode'],
                  )
                }
                className={INPUT_CLASS}
              >
                <option value="default">Comisión general</option>
                <option value="fixed_item">Específica para este producto</option>
                <option value="fixed_order">Específica para toda la orden</option>
              </select>
            </Field>
            <Field
              label="Porcentaje específico"
              hint={commissionMode === 'default' ? 'No aplica con la comisión general.' : 'Entre 0 y 100.'}
            >
              <input
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={commissionValue}
                onChange={(event) => setCommissionValue(event.target.value)}
                disabled={commissionMode === 'default'}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Costo por obsequio para el asesor (USD)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={advisorGiftCostUsd}
                onChange={(event) => setAdvisorGiftCostUsd(event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Pago interno de delivery (USD)">
              <input
                type="number"
                min="0"
                step="0.01"
                value={internalRiderPayUsd}
                onChange={(event) => setInternalRiderPayUsd(event.target.value)}
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Nota de comisión (opcional)">
              <input
                value={commissionNotes}
                onChange={(event) => setCommissionNotes(event.target.value)}
                maxLength={1000}
                className={INPUT_CLASS}
              />
            </Field>
          </div>
        </div>
        <Feedback message={message} error={error} />
        <button type="button" onClick={save} disabled={isPending} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {isPending ? 'Guardando…' : 'Guardar datos comerciales'}
        </button>
      </div>

      <ImpactCard title="Impacto antes de guardar">
        <ImpactLine label="Política" value={product.inventory_policy ? policyLabels[product.inventory_policy] : 'Sin clasificar'} />
        <ImpactLine label="Órdenes históricas" value={quantity(product.order_reference_count)} />
        <ImpactLine label="Órdenes abiertas" value={quantity(product.open_order_reference_count)} />
        <ImpactLine label="Usado dentro de productos" value={quantity(product.parent_product_count)} />
        <div className="mt-3 border-t border-[#2B2B38] pt-3">
          <div className="text-xs font-semibold text-[#B7B7C1]">Descuento físico (solo lectura)</div>
          {product.links.length ? product.links.map((link) => (
            <div key={`${product.id}:${link.inventory_item_id}`} className="mt-2 text-xs leading-5 text-[#9797A4]">
              {quantity(link.quantity_units)} de {link.item_name}
              {link.deduction_stage ? ` · ${link.deduction_stage}` : ''}
            </div>
          )) : <div className="mt-2 text-xs text-[#858591]">No tiene enlace directo; se resuelve por composición o no descuenta.</div>}
        </div>
        <div className="mt-3 rounded-lg border border-sky-400/20 bg-sky-400/5 px-3 py-2 text-xs leading-5 text-sky-100">
          Este editor modifica identidad, precio y condiciones comerciales. No modifica componentes,
          recetas, existencias ni cantidades descontadas.
        </div>
      </ImpactCard>
    </div>
  );
}

function ItemEditor({ item }: { item: AdminItem }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState(item.name);
  const [availabilityMode, setAvailabilityMode] = useState(item.availability_mode ?? '');
  const [lowStockThreshold, setLowStockThreshold] = useState(item.low_stock_threshold == null ? '' : String(item.low_stock_threshold));
  const [lowStockInclusive, setLowStockInclusive] = useState(item.low_stock_inclusive);
  const [targetStockUnits, setTargetStockUnits] = useState(item.target_stock_units == null ? '' : String(item.target_stock_units));
  const [shelfLifeDays, setShelfLifeDays] = useState(item.shelf_life_days == null ? '' : String(item.shelf_life_days));
  const [countFrequency, setCountFrequency] = useState(item.primary_count_frequency ?? '');
  const [countRole, setCountRole] = useState(item.primary_count_role ?? '');
  const [notes, setNotes] = useState(item.notes ?? '');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        await updateInventoryItemControlsAction({
          inventoryItemId: item.id,
          name,
          availabilityMode: (availabilityMode || null) as AdminItem['availability_mode'],
          lowStockThreshold: optionalDecimal(lowStockThreshold),
          lowStockInclusive,
          targetStockUnits: optionalDecimal(targetStockUnits),
          shelfLifeDays: optionalDecimal(shelfLifeDays),
          primaryCountFrequency: (countFrequency || null) as AdminItem['primary_count_frequency'],
          primaryCountRole: (countRole || null) as AdminItem['primary_count_role'],
          notes,
        });
        setMessage('Controles actualizados sin modificar la existencia física.');
        router.refresh();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'No se pudo modificar el ítem.');
      }
    });
  }

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre del ítem">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} className={INPUT_CLASS} />
          </Field>
          <Field label="Disponibilidad">
            <select value={availabilityMode} onChange={(event) => setAvailabilityMode(event.target.value as typeof availabilityMode)} className={INPUT_CLASS}>
              <option value="">Sin definir</option>
              <option value="on_hand_only">Solo existencia física</option>
              <option value="immediate_recipe">Preparación inmediata</option>
              <option value="scheduled_recipe">Preparación con tiempo</option>
            </select>
          </Field>
          <Field label="Encender alerta desde">
            <input inputMode="decimal" value={lowStockThreshold} onChange={(event) => setLowStockThreshold(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Stock objetivo">
            <input inputMode="decimal" value={targetStockUnits} onChange={(event) => setTargetStockUnits(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Vida útil en días">
            <input type="number" min="0" step="1" value={shelfLifeDays} onChange={(event) => setShelfLifeDays(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Frecuencia principal de conteo">
            <select value={countFrequency} onChange={(event) => setCountFrequency(event.target.value as typeof countFrequency)} className={INPUT_CLASS}>
              <option value="">Sin frecuencia</option>
              <option value="per_shift">Por turno</option>
              <option value="daily">Diaria</option>
              <option value="weekly">Semanal</option>
              <option value="biweekly">Quincenal</option>
              <option value="monthly">Mensual</option>
            </select>
          </Field>
          <Field label="Responsable del conteo">
            <select value={countRole} onChange={(event) => setCountRole(event.target.value as typeof countRole)} className={INPUT_CLASS}>
              <option value="">Sin responsable</option>
              <option value="kitchen">Cocina</option>
              <option value="master">Máster</option>
              <option value="admin">Administración</option>
              <option value="counter">Counter</option>
            </select>
          </Field>
          <div className="flex items-end pb-2">
            <Checkbox checked={lowStockInclusive} onChange={setLowStockInclusive} label="Alertar también al llegar exactamente al mínimo" />
          </div>
          <div className="md:col-span-2">
            <Field label="Nota operativa">
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} className={INPUT_CLASS} />
            </Field>
          </div>
        </div>
        <Feedback message={message} error={error} />
        <button type="button" onClick={save} disabled={isPending} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {isPending ? 'Guardando…' : 'Guardar controles del ítem'}
        </button>
      </div>

      <ImpactCard title="Estructura protegida">
        <ImpactLine label="Estado" value={item.is_active ? 'Activo' : 'Borrador'} />
        <ImpactLine label="Saldo actual" value={`${quantity(item.current_stock_units)} ${item.unit_name}`} />
        <ImpactLine label="Disponibilidad" value={item.availability_mode ? availabilityLabels[item.availability_mode] : 'Sin definir'} />
        <ImpactLine label="Unidad base" value={item.unit_name} />
        <ImpactLine label="Tipo" value={item.inventory_kind} />
        <ImpactLine label="Grupo" value={item.inventory_group} />
        <ImpactLine label="Seguimiento" value={item.tracking_mode ?? 'sin definir'} />
        <ImpactLine label="Productos vinculados" value={quantity(item.product_reference_count)} />
        <ImpactLine label="Recetas que lo consumen" value={quantity(item.recipe_input_count)} />
        <div className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-100">
          Unidad, tipo, grupo y seguimiento quedan bloqueados aquí porque cambiarlos reinterpretaría movimientos históricos.
        </div>
      </ImpactCard>
    </div>
  );
}

function RecipeEditor({
  outputItem,
  items,
  kind,
  activeRecipe,
  draftRecipe,
  history,
}: {
  outputItem: AdminItem;
  items: AdminItem[];
  kind: AdminRecipe['recipe_kind'];
  activeRecipe: AdminRecipe | null;
  draftRecipe: AdminRecipe | null;
  history: AdminRecipe[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const baseRecipe = draftRecipe ?? activeRecipe;
  const [outputQuantity, setOutputQuantity] = useState(String(baseRecipe?.output_quantity_units ?? 1));
  const [leadTime, setLeadTime] = useState(String(baseRecipe?.lead_time_minutes ?? 0));
  const [productionMultiple, setProductionMultiple] = useState(String(baseRecipe?.production_multiple ?? 1));
  const [notes, setNotes] = useState(cleanRecipeNote(baseRecipe?.notes ?? null));
  const [lines, setLines] = useState<RecipeLine[]>(() =>
    baseRecipe?.components.length
      ? baseRecipe.components.map((component, index) => ({
          key: `${component.input_inventory_item_id}:${index}`,
          inputInventoryItemId: String(component.input_inventory_item_id),
          quantityUnits: String(component.quantity_units),
        }))
      : [{ key: 'initial', inputInventoryItemId: '', quantityUnits: '' }],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const computedBlockers = useMemo(() => {
    const blockers = new Set<string>();
    if (!outputItem.is_active || !outputItem.has_accepted_opening) blockers.add(outputItem.name);
    for (const line of lines) {
      const input = items.find((candidate) => candidate.id === Number(line.inputInventoryItemId));
      if (input && (!input.is_active || !input.has_accepted_opening)) blockers.add(input.name);
    }
    return Array.from(blockers);
  }, [items, lines, outputItem]);

  function saveDraft() {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveInventoryRecipeDraftAction({
          draftRecipeId: draftRecipe?.id ?? null,
          sourceRecipeId: activeRecipe?.id ?? null,
          outputInventoryItemId: outputItem.id,
          recipeKind: kind,
          outputQuantityUnits: parseDecimalInput(outputQuantity),
          leadTimeMinutes: Number(leadTime),
          productionMultiple: parseDecimalInput(productionMultiple),
          notes,
          components: lines.map((line) => ({
            inputInventoryItemId: Number(line.inputInventoryItemId),
            quantityUnits: parseDecimalInput(line.quantityUnits),
          })),
        });
        setMessage(`Versión ${result?.version ?? 'nueva'} guardada como borrador. La receta activa no cambió.`);
        router.refresh();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'No se pudo guardar la receta.');
      }
    });
  }

  function activateDraft() {
    if (!draftRecipe) return;
    const confirmation = window.confirm(
      `Vas a activar la receta v${draftRecipe.version} de ${outputItem.name}. La versión actual quedará como historial. ¿Continuar?`,
    );
    if (!confirmation) return;
    setMessage(null);
    setError(null);
    startTransition(async () => {
      try {
        await activateInventoryRecipeAction({ recipeId: draftRecipe.id });
        setMessage(`La receta v${draftRecipe.version} quedó activa. La versión anterior se conservó como historial.`);
        router.refresh();
      } catch (activationError) {
        setError(activationError instanceof Error ? activationError.message : 'No se pudo activar la receta.');
      }
    });
  }

  return (
    <div className="mt-4">
      <div className="grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-semibold">{draftRecipe ? `Editar borrador v${draftRecipe.version}` : activeRecipe ? `Crear versión desde v${activeRecipe.version}` : 'Crear primera receta'}</h3>
              <p className="mt-1 text-xs text-[#8D8D99]">Salida: {outputItem.name} · {outputItem.unit_name}</p>
            </div>
            {draftRecipe ? <StatusBadge tone="warn">Borrador sin activar</StatusBadge> : activeRecipe ? <StatusBadge tone="good">v{activeRecipe.version} sigue activa</StatusBadge> : <StatusBadge tone="neutral">Sin receta activa</StatusBadge>}
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <Field label={`Salida producida (${outputItem.unit_name})`}>
              <input inputMode="decimal" value={outputQuantity} onChange={(event) => setOutputQuantity(event.target.value)} className={INPUT_CLASS} />
            </Field>
            <Field label="Tiempo en minutos">
              <input type="number" min="0" step="1" value={leadTime} onChange={(event) => setLeadTime(event.target.value)} className={INPUT_CLASS} />
            </Field>
            <Field label="Múltiplo permitido">
              <input inputMode="decimal" value={productionMultiple} onChange={(event) => setProductionMultiple(event.target.value)} className={INPUT_CLASS} />
            </Field>
          </div>

          <div className="mt-5 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-semibold">Insumos consumidos</div>
              <div className="mt-1 text-xs text-[#858591]">La cantidad corresponde a una salida de la receta.</div>
            </div>
            <button type="button" onClick={() => setLines((current) => [...current, { key: crypto.randomUUID(), inputInventoryItemId: '', quantityUnits: '' }])} className={SECONDARY_BUTTON}>
              Agregar insumo
            </button>
          </div>

          <div className="mt-3 space-y-3">
            {lines.map((line, index) => (
              <div key={line.key} className="grid gap-2 rounded-xl border border-[#292938] bg-[#101016] p-3 md:grid-cols-[1fr_180px_auto] md:items-end">
                <Field label={`Insumo ${index + 1}`}>
                  <select value={line.inputInventoryItemId} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, inputInventoryItemId: event.target.value } : candidate))} className={INPUT_CLASS}>
                    <option value="">Selecciona un ítem…</option>
                    {items.filter((candidate) => candidate.tracking_mode === 'transactional' && candidate.id !== outputItem.id).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name} · disponible {quantity(candidate.current_stock_units)}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Cantidad consumida">
                  <input inputMode="decimal" value={line.quantityUnits} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, quantityUnits: event.target.value } : candidate))} className={INPUT_CLASS} />
                </Field>
                <button type="button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))} className={`${SECONDARY_BUTTON} text-[#FB7185]`}>
                  Quitar
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4">
            <Field label="Explicación del cambio">
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} className={INPUT_CLASS} placeholder="Ej. nueva presentación de 10 Bombys; consume 10 piezas crudas." />
            </Field>
          </div>
          <Feedback message={message} error={error} />
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={saveDraft} disabled={isPending} className={PRIMARY_BUTTON}>
              {isPending ? 'Procesando…' : draftRecipe ? 'Actualizar borrador' : 'Guardar nueva versión'}
            </button>
            {draftRecipe ? (
              <button type="button" onClick={activateDraft} disabled={isPending || draftRecipe.activation_blockers.length > 0} className={SECONDARY_BUTTON}>
                Activar v{draftRecipe.version}
              </button>
            ) : null}
          </div>
        </div>

        <div className="space-y-4">
          <ImpactCard title="Comparación e impacto">
            {activeRecipe ? (
              <RecipeSummary title={`Operativa ahora · v${activeRecipe.version}`} recipe={activeRecipe} />
            ) : (
              <div className="text-xs text-[#8D8D99]">No existe una receta activa para esta salida.</div>
            )}
            <div className="my-3 border-t border-[#2B2B38]" />
            <div className="text-xs font-semibold uppercase tracking-wide text-[#FEEF00]">Configuración en pantalla</div>
            <div className="mt-2 text-sm text-white">Produce {outputQuantity || '—'} {outputItem.unit_name}</div>
            <div className="mt-1 text-xs text-[#9595A2]">Tiempo: {leadTime || '0'} min · múltiplo {productionMultiple || '—'}</div>
            <div className="mt-2 space-y-1 text-xs text-[#B0B0BB]">
              {lines.map((line) => {
                const input = items.find((candidate) => candidate.id === Number(line.inputInventoryItemId));
                return <div key={`preview:${line.key}`}>{line.quantityUnits || '—'} de {input?.name ?? 'insumo sin seleccionar'}</div>;
              })}
            </div>
          </ImpactCard>

          <ImpactCard title="Condiciones para activar">
            {(draftRecipe?.activation_blockers ?? computedBlockers).length ? (
              <div className="rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-100">
                Falta activar o aceptar la apertura de: {(draftRecipe?.activation_blockers ?? computedBlockers).join(', ')}.
              </div>
            ) : (
              <div className="rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-3 py-2 text-xs leading-5 text-emerald-100">
                Los ítems tienen apertura aceptada. Después de guardar, el borrador podrá activarse.
              </div>
            )}
            <div className="mt-3 text-xs leading-5 text-[#9696A3]">
              Activar cambia solo las producciones futuras. Los lotes ya iniciados conservan la versión con la que comenzaron.
            </div>
            {activeRecipe?.active_batch_count ? <div className="mt-2 text-xs text-sky-200">Hay {activeRecipe.active_batch_count} producción(es) en curso con la receta vigente.</div> : null}
          </ImpactCard>

          {history.length ? (
            <ImpactCard title="Historial conservado">
              {history.map((recipe) => (
                <div key={recipe.id} className="border-b border-[#292938] py-2 text-xs text-[#A4A4AF] last:border-0">
                  v{recipe.version} · {quantity(recipe.output_quantity_units)} de salida · {recipe.lead_time_minutes} min
                </div>
              ))}
            </ImpactCard>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RecipeSummary({ title, recipe }: { title: string; recipe: AdminRecipe }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-wide text-emerald-300">{title}</div>
      <div className="mt-2 text-sm text-white">Produce {quantity(recipe.output_quantity_units)} {recipe.output_unit_name}</div>
      <div className="mt-1 text-xs text-[#9595A2]">Tiempo: {recipe.lead_time_minutes} min · múltiplo {quantity(recipe.production_multiple)}</div>
      <div className="mt-2 space-y-1 text-xs text-[#B0B0BB]">
        {recipe.components.map((component) => (
          <div key={`${recipe.id}:${component.input_inventory_item_id}`}>{quantity(component.quantity_units)} de {component.input_name}</div>
        ))}
      </div>
    </div>
  );
}

function RuleCard({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[#FEEF00] text-xs font-black text-black">{number}</span>
        <div className="text-sm font-semibold">{title}</div>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#92929F]">{children}</p>
    </div>
  );
}

function EditorButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className={`rounded-xl border px-4 py-2.5 text-sm font-semibold ${active ? 'border-[#FEEF00]/60 bg-[#2A2910] text-[#FEEF00]' : 'border-[#343443] bg-[#17171F] text-[#B7B7C1]'}`}>
      {children}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block text-xs text-[#A6A6B2]">
      <span className="mb-1.5 block font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block leading-5 text-[#858591]">{hint}</span> : null}
    </label>
  );
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs leading-5 text-[#B7B7C1]">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="mt-1 accent-[#FEEF00]" />
      <span>{label}</span>
    </label>
  );
}

function ImpactCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <aside className="rounded-xl border border-[#292938] bg-[#111117] p-4">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="mt-3">{children}</div>
    </aside>
  );
}

function ImpactLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[#292938] py-2 text-xs last:border-0">
      <span className="text-[#8F8F9C]">{label}</span>
      <span className="text-right font-medium text-[#D7D7DF]">{value}</span>
    </div>
  );
}

function StatusBadge({ tone, children }: { tone: 'good' | 'warn' | 'neutral'; children: ReactNode }) {
  const className = tone === 'good' ? 'border-emerald-400/25 text-emerald-200' : tone === 'warn' ? 'border-amber-400/25 text-amber-200' : 'border-[#3A3A48] text-[#A6A6B2]';
  return <span className={`rounded-full border px-3 py-1 text-xs ${className}`}>{children}</span>;
}

function Feedback({ message, error }: { message: string | null; error: string | null }) {
  if (!message && !error) return null;
  return (
    <div role={error ? 'alert' : 'status'} className={`mt-4 rounded-xl border px-3 py-2 text-sm ${error ? 'border-red-400/30 bg-red-400/5 text-red-200' : 'border-emerald-400/30 bg-emerald-400/5 text-emerald-100'}`}>
      {error ?? message}
    </div>
  );
}

function EmptyEditor() {
  return (
    <div className="mt-4 rounded-xl border border-dashed border-[#343443] px-4 py-8 text-center text-sm text-[#858591]">
      Selecciona un registro para ver su configuración, dependencias e impacto.
    </div>
  );
}
