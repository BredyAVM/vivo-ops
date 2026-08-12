'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useMemo, useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import {
  activateInventoryRecipeAction,
  saveInventoryRecipeDraftAction,
  setInventoryItemActiveStatusAction,
  setInventoryProductActiveStatusAction,
  updateInventoryItemControlsAction,
  updateInventoryProductIdentityAction,
  updateInventoryProductPhysicalConfigurationAction,
} from '../actions';
import InventoryRouteEditor, {
  newPrimaryRoute,
  type InventoryRouteDraft,
} from './InventoryRouteEditor';

type ProductLink = {
  inventory_item_id: number;
  item_name: string;
  quantity_units: number;
  half_quantity_units: number | null;
  deduction_mode: string;
  deduction_stage: string | null;
};

type ProductRoute = {
  key: string;
  name: string;
  mode: 'primary' | 'master_fallback';
  links: ProductLink[];
};

type ProductComponent = {
  component_product_id: number;
  component_name: string;
  component_mode: 'fixed' | 'selectable';
  quantity: number;
  counts_toward_detail_limit: boolean;
  is_required: boolean;
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
  routes: ProductRoute[];
  components: ProductComponent[];
  physical_revision: number;
  physical_history_count: number;
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
type PhysicalComponentLine = {
  key: string;
  componentProductId: string;
  componentMode: 'fixed' | 'selectable';
  quantity: string;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
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

const frequencyLabels: Record<NonNullable<AdminItem['primary_count_frequency']>, string> = {
  per_shift: 'Por turno',
  daily: 'Diaria',
  weekly: 'Semanal',
  biweekly: 'Quincenal',
  monthly: 'Mensual',
};

const roleLabels: Record<NonNullable<AdminItem['primary_count_role']>, string> = {
  admin: 'Administración',
  master: 'Máster',
  kitchen: 'Cocina',
  counter: 'Counter',
};

function frequencyLabel(value: NonNullable<AdminItem['primary_count_frequency']>) {
  return frequencyLabels[value];
}

function roleLabel(value: AdminItem['primary_count_role']) {
  return value ? roleLabels[value] : 'Pendiente de asignar';
}

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
  initialItemId = null,
}: {
  workspace: InventoryAdminWorkspace;
  initialItemId?: number | null;
}) {
  const [editor, setEditor] = useState<Editor>('item');
  const [productId, setProductId] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [itemId, setItemId] = useState(initialItemId ? String(initialItemId) : '');
  const [itemSearch, setItemSearch] = useState('');
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
  const visibleItems = useMemo(() => {
    const query = itemSearch.trim().toLocaleLowerCase('es');
    if (!query) return workspace.items;
    return workspace.items.filter((candidate) =>
      `${candidate.name} ${candidate.inventory_group} ${candidate.inventory_kind}`
        .toLocaleLowerCase('es')
        .includes(query),
    );
  }, [itemSearch, workspace.items]);
  const visibleProducts = useMemo(() => {
    const query = productSearch.trim().toLocaleLowerCase('es');
    if (!query) return workspace.products;
    const terms = query.split(/\s+/).filter(Boolean);
    return workspace.products.filter((candidate) => {
      const searchable = `${candidate.name} ${candidate.sku ?? ''} ${candidate.is_active ? 'activo' : 'inactivo'}`
        .toLocaleLowerCase('es');
      return terms.every((term) => searchable.includes(term));
    });
  }, [productSearch, workspace.products]);
  const adjustedComboCount = workspace.products.filter((candidate) =>
    candidate.name.toLocaleLowerCase('es').includes('combo')
    && candidate.name.toLocaleLowerCase('es').includes('ajustado'),
  ).length;

  return (
    <section className="rounded-2xl border border-[#2C2C3A] bg-[#101016] p-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#FEEF00]">
            Perfil de inventario
          </div>
          <h2 className="mt-1 text-xl font-semibold">Configurar un producto o ítem existente</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#9898A5]">
            Empieza por el ítem físico para definir cómo se cuenta. Cambia a producto comercial
            para precio y comisión, o a receta para modificar lo que consume o produce.
          </p>
        </div>
        <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/5 px-4 py-3 text-xs leading-5 text-emerald-100">
          <div className="font-semibold">Órdenes sin bloqueo</div>
          <div>Estas modificaciones no impiden crear ni enviar órdenes.</div>
        </div>
      </div>

      <div className="mt-5 grid gap-3 lg:grid-cols-3">
        <RuleCard number="1" title="Ítem e inventario">
          Frecuencia, responsable, alertas, objetivo y disponibilidad física.
        </RuleCard>
        <RuleCard number="2" title="Producto y venta">
          Nombre comercial, precio, comisión y forma de descontar.
        </RuleCard>
        <RuleCard number="3" title="Preparación">
          Insumos, rendimiento y tiempo. Se compara y se activa explícitamente.
        </RuleCard>
      </div>

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Tipo de configuración">
        <EditorButton active={editor === 'item'} onClick={() => setEditor('item')}>
          Inventario del ítem
        </EditorButton>
        <EditorButton active={editor === 'product'} onClick={() => setEditor('product')}>
          Datos y descuento del producto
        </EditorButton>
        <EditorButton active={editor === 'recipe'} onClick={() => setEditor('recipe')}>
          Receta o preparación
        </EditorButton>
      </div>

      {editor === 'product' ? (
        <div className="mt-5">
          <div className="grid gap-3 md:grid-cols-[minmax(220px,0.8fr)_minmax(320px,1.2fr)]">
            <Field label="Buscar producto">
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Ej. combo ajustado, Baby o SEXYMIX"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Producto comercial">
              <select
                value={productId}
                onChange={(event) => setProductId(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Selecciona un producto…</option>
                {visibleProducts.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.sku ?? 'sin SKU'} · {candidate.is_active ? 'activo' : 'inactivo'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[#858591]">
            <span>{visibleProducts.length} de {workspace.products.length} productos visibles.</span>
            {adjustedComboCount > 0 ? (
              <button
                type="button"
                onClick={() => setProductSearch('combo ajustado')}
                className="rounded-full border border-[#FEEF00]/30 px-2.5 py-1 font-semibold text-[#FEEF00]"
              >
                Ver combos ajustados ({adjustedComboCount})
              </button>
            ) : null}
            {productSearch ? (
              <button type="button" onClick={() => setProductSearch('')} className="font-semibold text-[#B8B8C4] underline">
                Mostrar todos
              </button>
            ) : null}
          </div>
          {product ? (
            <ProductEditor
              key={product.id}
              product={product}
              products={workspace.products}
              items={workspace.items}
            />
          ) : <EmptyEditor />}
        </div>
      ) : null}

      {editor === 'item' ? (
        <div className="mt-5">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Buscar por nombre, familia o tipo">
              <input
                value={itemSearch}
                onChange={(event) => setItemSearch(event.target.value)}
                placeholder="Ej. Bombys, bebidas o prefrito"
                className={INPUT_CLASS}
              />
            </Field>
            <Field label="Ítem físico">
              <select
                value={itemId}
                onChange={(event) => setItemId(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Selecciona un ítem…</option>
                {visibleItems.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {candidate.inventory_group} · {candidate.is_active ? 'activo' : 'borrador'}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="mt-2 text-xs text-[#777784]">
            {visibleItems.length} de {workspace.items.length} ítems visibles. Cualquier ítem puede contarse por solicitud aunque no tenga calendario.
          </p>
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

function ProductEditor({
  product,
  products,
  items,
}: {
  product: AdminProduct;
  products: AdminProduct[];
  items: AdminItem[];
}) {
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
  const [lifecycleNote, setLifecycleNote] = useState('');
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

  function toggleProductStatus() {
    setMessage(null);
    setError(null);
    const nextIsActive = !product.is_active;
    const accepted = window.confirm(
      nextIsActive
        ? `¿Reactivar ${product.name} en el catálogo?`
        : `¿Desactivar ${product.name}? No aparecerá en ventas nuevas, pero las órdenes abiertas conservarán el producto.`,
    );
    if (!accepted) return;

    startTransition(async () => {
      try {
        const result = await setInventoryProductActiveStatusAction({
          productId: product.id,
          nextIsActive,
          note: lifecycleNote.trim() || null,
        });
        setMessage(
          nextIsActive
            ? 'Producto reactivado en el catálogo.'
            : `Producto desactivado sin bloquear órdenes${result?.open_order_count ? `; conserva ${result.open_order_count} orden(es) abierta(s)` : ''}.`,
        );
        router.refresh();
      } catch (statusError) {
        setError(statusError instanceof Error ? statusError.message : 'No se pudo cambiar el estado del producto.');
      }
    });
  }

  return (
    <div className="mt-4 space-y-4">
      <div className={`rounded-xl border p-4 ${product.is_active ? 'border-emerald-400/25 bg-emerald-400/5' : 'border-amber-400/25 bg-amber-400/5'}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">Estado del producto</h3>
              <StatusBadge tone={product.is_active ? 'good' : 'warn'}>
                {product.is_active ? 'Activo para ventas nuevas' : 'Inactivo / fuera de temporada'}
              </StatusBadge>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#A5A5B0]">
              Desactivar no borra el producto, no cambia existencias y no impide completar órdenes que ya lo contienen.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(260px,1fr)_auto]">
            <input
              value={lifecycleNote}
              onChange={(event) => setLifecycleNote(event.target.value)}
              maxLength={500}
              placeholder="Motivo o temporada (opcional)"
              className={INPUT_CLASS}
            />
            <button type="button" onClick={toggleProductStatus} disabled={isPending} className={SECONDARY_BUTTON}>
              {product.is_active ? 'Desactivar producto' : 'Reactivar producto'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
      <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Nombre comercial">
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} className={INPUT_CLASS} />
          </Field>
          <Field label="SKU">
            <input value={sku} onChange={(event) => setSku(event.target.value)} maxLength={64} className={INPUT_CLASS} />
          </Field>
          <Field label="Unidades por servicio">
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
        <button type="button" onClick={save} disabled={isPending || !product.is_active} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {isPending ? 'Guardando…' : 'Guardar datos comerciales'}
        </button>
      </div>

      <ImpactCard title="Impacto antes de guardar">
        <ImpactLine label="Política" value={product.inventory_policy ? policyLabels[product.inventory_policy] : 'Sin clasificar'} />
        <ImpactLine label="Órdenes históricas" value={quantity(product.order_reference_count)} />
        <ImpactLine label="Órdenes abiertas" value={quantity(product.open_order_reference_count)} />
        <ImpactLine label="Usado dentro de productos" value={quantity(product.parent_product_count)} />
        <div className="mt-3 border-t border-[#2B2B38] pt-3">
          <div className="text-xs font-semibold text-[#B7B7C1]">Rutas físicas (solo lectura)</div>
          {product.routes.length ? product.routes.map((route) => (
            <div key={`${product.id}:${route.key}`} className="mt-3 rounded-lg border border-[#2B2B38] px-3 py-2">
              <div className="text-xs font-semibold text-[#D7D7DF]">
                {route.name} · {route.mode === 'primary' ? 'principal' : 'decisión del Máster'}
              </div>
              {route.links.map((link) => (
                <div key={`${route.key}:${link.inventory_item_id}`} className="mt-1 text-xs leading-5 text-[#9797A4]">
                  {quantity(link.quantity_units)} {items.find((item) => item.id === link.inventory_item_id)?.unit_name ?? 'UND'} de {link.item_name}
                  {link.half_quantity_units != null ? ` · medio: ${quantity(link.half_quantity_units)}` : ''}
                </div>
              ))}
            </div>
          )) : <div className="mt-2 text-xs text-[#858591]">Se resuelve por composición o no descuenta inventario.</div>}
        </div>
        <div className="mt-3 rounded-lg border border-sky-400/20 bg-sky-400/5 px-3 py-2 text-xs leading-5 text-sky-100">
          Este editor modifica identidad, precio y condiciones comerciales. No modifica componentes,
          recetas, existencias ni cantidades descontadas.
        </div>
      </ImpactCard>
      </div>

      {!product.is_active ? (
        <div className="rounded-xl border border-sky-400/25 bg-sky-400/5 px-4 py-3 text-sm leading-6 text-sky-100">
          Puedes preparar y guardar la composición mientras el producto sigue inactivo. No aparecerá en ventas hasta que lo reactives explícitamente arriba.
        </div>
      ) : null}
      <PhysicalConfigurationEditor product={product} products={products} items={items} />
    </div>
  );
}

function PhysicalConfigurationEditor({
  product,
  products,
  items,
}: {
  product: AdminProduct;
  products: AdminProduct[];
  items: AdminItem[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [policy, setPolicy] = useState<NonNullable<AdminProduct['inventory_policy']>>(
    product.inventory_policy ?? 'none',
  );
  const [detailUnitsLimit, setDetailUnitsLimit] = useState(String(product.detail_units_limit));
  const [changeNote, setChangeNote] = useState('');
  const [routes, setRoutes] = useState<InventoryRouteDraft[]>(() =>
    product.routes.length
      ? product.routes.map((route) => ({
          key: crypto.randomUUID(),
          routeKey: route.key,
          name: route.name,
          mode: route.mode,
          links: route.links.map((link) => ({
            key: crypto.randomUUID(),
            inventoryItemId: String(link.inventory_item_id),
            quantityUnits: String(link.quantity_units),
            halfQuantityUnits: link.half_quantity_units == null ? '' : String(link.half_quantity_units),
            deductionStage: (link.deduction_stage || 'fulfillment') as InventoryRouteDraft['links'][number]['deductionStage'],
          })),
        }))
      : [newPrimaryRoute()],
  );
  const [components, setComponents] = useState<PhysicalComponentLine[]>(() =>
    product.components.length
      ? product.components.map((component, index) => ({
          key: `${component.component_product_id}:${component.component_mode}:${index}`,
          componentProductId: String(component.component_product_id),
          componentMode: component.component_mode,
          quantity: String(component.quantity),
          countsTowardDetailLimit: component.counts_toward_detail_limit,
          isRequired: component.is_required,
        }))
      : [{
          key: 'initial-component',
          componentProductId: '',
          componentMode: 'fixed',
          quantity: '1',
          countsTowardDetailLimit: true,
          isRequired: true,
        }],
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectableItems = items.filter(
    (item) => item.is_active && item.tracking_mode !== 'not_tracked',
  );
  const selectableProducts = products.filter(
    (candidate) => candidate.id !== product.id && candidate.inventory_configuration_status === 'ready',
  );
  const fixedServiceUnits = components.reduce((total, line) => {
    if (line.componentMode !== 'fixed') return total;
    const componentProduct = products.find((candidate) => candidate.id === Number(line.componentProductId));
    if (componentProduct?.type !== 'service') return total;
    const componentQuantity = Number(String(line.quantity).replace(',', '.'));
    return total + (Number.isFinite(componentQuantity) ? componentQuantity : 0);
  }, 0);
  const otherFixedUnits = components.reduce((total, line) => {
    if (line.componentMode !== 'fixed') return total;
    const componentProduct = products.find((candidate) => candidate.id === Number(line.componentProductId));
    if (!componentProduct || componentProduct.type === 'service') return total;
    const componentQuantity = Number(String(line.quantity).replace(',', '.'));
    return total + (Number.isFinite(componentQuantity) ? componentQuantity : 0);
  }, 0);

  function savePhysicalConfiguration() {
    setMessage(null);
    setError(null);
    const accepted = window.confirm(
      `Se guardará la revisión física v${product.physical_revision + 1} de ${product.name}. `
      + 'La existencia no cambia y las órdenes ya comprometidas conservan su cálculo. ¿Continuar?',
    );
    if (!accepted) return;

    startTransition(async () => {
      try {
        const result = await updateInventoryProductPhysicalConfigurationAction({
          productId: product.id,
          inventoryPolicy: policy,
          detailUnitsLimit: Number(detailUnitsLimit),
          changeNote,
          routes: policy === 'self' || policy === 'direct'
            ? routes
              .filter((route) => policy === 'direct' || route.mode === 'primary')
              .map((route) => ({
                key: route.routeKey,
                name: route.name,
                mode: route.mode,
                links: route.links.slice(0, policy === 'direct' ? route.links.length : 1).map((line) => ({
                  inventoryItemId: Number(line.inventoryItemId),
                  quantityUnits: parseDecimalInput(line.quantityUnits),
                  halfQuantityUnits: product.allows_half_service && line.halfQuantityUnits.trim()
                    ? parseDecimalInput(line.halfQuantityUnits)
                    : null,
                  deductionStage: line.deductionStage || null,
                })),
              }))
            : [],
          components: policy === 'components'
            ? components.map((line) => ({
                componentProductId: Number(line.componentProductId),
                componentMode: line.componentMode,
                quantity: parseDecimalInput(line.quantity),
                countsTowardDetailLimit: line.countsTowardDetailLimit,
                isRequired: line.isRequired,
              }))
            : [],
        });
        setMessage(`Revisión física v${result?.revision ?? product.physical_revision + 1} activada sin modificar existencias.`);
        router.refresh();
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : 'No se pudo versionar la configuración física.');
      }
    });
  }

  return (
    <div className="rounded-xl border border-[#3A3518] bg-[#17150B] p-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-sm font-semibold text-[#FEEF00]">Qué descuenta este producto</div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#B7B39A]">
            Esta es la regla física activa. Cada cambio crea una revisión, conserva la anterior en
            el historial del producto y no altera saldos ni detiene órdenes.
          </p>
        </div>
        <div className="rounded-full border border-[#FEEF00]/30 px-3 py-1 text-xs text-[#FEEF00]">
          Revisión v{product.physical_revision} · {product.physical_history_count} anteriores
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Forma de descuento">
          <select
            value={policy}
            onChange={(event) => setPolicy(event.target.value as typeof policy)}
            className={INPUT_CLASS}
          >
            <option value="self">Se descuenta a sí mismo</option>
            <option value="direct">Consume uno o varios ítems físicos</option>
            <option value="components">Se arma con productos componentes</option>
            <option value="none">No descuenta inventario</option>
          </select>
        </Field>
        {policy === 'components' ? (
          <Field label="Unidades seleccionables por unidad vendida">
            <input type="number" min="0" step="1" value={detailUnitsLimit} onChange={(event) => setDetailUnitsLimit(event.target.value)} className={INPUT_CLASS} />
          </Field>
        ) : <div />}
      </div>

      {policy === 'self' || policy === 'direct' ? (
        <div className="mt-4">
          <InventoryRouteEditor
            routes={routes}
            setRoutes={setRoutes}
            inventoryItems={selectableItems.map((item) => ({
              id: item.id,
              name: item.name,
              unitName: item.unit_name,
            }))}
            allowsHalfService={product.allows_half_service}
            allowFallbacks={policy === 'direct'}
            allowMultipleLinks={policy === 'direct'}
            disabled={isPending}
          />
        </div>
      ) : null}

      {policy === 'components' ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-2 rounded-xl border border-[#373322] bg-[#11100B] px-3 py-2 text-xs">
            <span className="font-semibold text-white">Composición actual:</span>
            <span className="text-[#FEEF00]">{quantity(fixedServiceUnits)} UND de productos</span>
            {otherFixedUnits > 0 ? <span className="text-[#B7B39A]">+ {quantity(otherFixedUnits)} adicional(es)</span> : null}
          </div>
          {components.map((line) => (
            <div key={line.key} className="rounded-xl border border-[#373322] bg-[#11100B] p-3">
              <div className="grid gap-2 md:grid-cols-[1fr_160px_140px_auto]">
                <select value={line.componentProductId} onChange={(event) => setComponents((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, componentProductId: event.target.value } : candidate))} className={INPUT_CLASS}>
                  <option value="">Selecciona el producto componente…</option>
                  {selectableProducts.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                </select>
                <select value={line.componentMode} onChange={(event) => setComponents((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, componentMode: event.target.value as PhysicalComponentLine['componentMode'], isRequired: event.target.value === 'fixed' } : candidate))} className={INPUT_CLASS}>
                  <option value="fixed">Fijo</option>
                  <option value="selectable">Seleccionable</option>
                </select>
                <input inputMode="decimal" value={line.quantity} onChange={(event) => setComponents((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, quantity: event.target.value } : candidate))} className={INPUT_CLASS} aria-label="Cantidad del componente" />
                <button type="button" onClick={() => setComponents((current) => current.filter((candidate) => candidate.key !== line.key))} className={SECONDARY_BUTTON}>Quitar</button>
              </div>
              <div className="mt-3 flex flex-wrap gap-4">
                <Checkbox checked={line.countsTowardDetailLimit} onChange={(checked) => setComponents((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, countsTowardDetailLimit: checked } : candidate))} label="Cuenta para el límite" />
                <Checkbox checked={line.isRequired} onChange={(checked) => setComponents((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, isRequired: checked } : candidate))} label="Obligatorio" />
              </div>
            </div>
          ))}
          <button type="button" onClick={() => setComponents((current) => [...current, { key: crypto.randomUUID(), componentProductId: '', componentMode: 'fixed', quantity: '1', countsTowardDetailLimit: true, isRequired: true }])} className={SECONDARY_BUTTON}>Agregar componente</button>
        </div>
      ) : null}

      <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <Field label="Motivo del cambio (recomendado)">
          <input value={changeNote} onChange={(event) => setChangeNote(event.target.value)} maxLength={1000} placeholder="Ej. La nueva presentación de Bombys trae 10 unidades" className={INPUT_CLASS} />
        </Field>
        <button type="button" onClick={savePhysicalConfiguration} disabled={isPending} className={PRIMARY_BUTTON}>
          {isPending ? 'Guardando revisión…' : 'Guardar nueva revisión física'}
        </button>
      </div>
      <Feedback message={message} error={error} />
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
  const [lifecycleNote, setLifecycleNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function save() {
    setMessage(null);
    setError(null);
    if (countFrequency && !countRole) {
      setError('Selecciona quién realiza el conteo programado.');
      return;
    }
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

  function toggleItemStatus() {
    setMessage(null);
    setError(null);
    const nextIsActive = !item.is_active;
    const accepted = window.confirm(
      nextIsActive
        ? `¿Reactivar ${item.name} en inventario?`
        : `¿Retirar ${item.name} de conteos y alertas? Su saldo e historial se conservarán.`,
    );
    if (!accepted) return;

    startTransition(async () => {
      try {
        await setInventoryItemActiveStatusAction({
          inventoryItemId: item.id,
          nextIsActive,
          note: lifecycleNote.trim() || null,
        });
        setMessage(nextIsActive ? 'Ítem reactivado.' : 'Ítem retirado de conteos y alertas sin cambiar su saldo.');
        router.refresh();
      } catch (statusError) {
        setError(statusError instanceof Error ? statusError.message : 'No se pudo cambiar el estado del ítem.');
      }
    });
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <ProfileFact label="Estado" value={item.is_active ? 'Activo' : 'Borrador'} tone={item.is_active ? 'good' : 'neutral'} />
        <ProfileFact label="Familia" value={item.inventory_group} />
        <ProfileFact label="Unidad base" value={item.unit_name} />
        <ProfileFact label="Existencia actual" value={`${quantity(item.current_stock_units)} ${item.unit_name}`} />
      </div>

      <div className={`rounded-xl border p-4 ${item.is_active ? 'border-emerald-400/20 bg-emerald-400/5' : 'border-amber-400/25 bg-amber-400/5'}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Participación en el inventario</h3>
            <p className="mt-1 text-xs leading-5 text-[#9494A0]">
              Un ítem inactivo no aparece en conteos ni genera alertas. El sistema impedirá retirarlo si todavía lo usa un producto, receta o flujo activo.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(260px,1fr)_auto]">
            <input
              value={lifecycleNote}
              onChange={(event) => setLifecycleNote(event.target.value)}
              maxLength={500}
              placeholder="Motivo del cambio (opcional)"
              className={INPUT_CLASS}
            />
            <button type="button" onClick={toggleItemStatus} disabled={isPending} className={SECONDARY_BUTTON}>
              {item.is_active ? 'Retirar del inventario' : 'Reactivar ítem'}
            </button>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
          <div className="mb-4">
            <h3 className="font-semibold">Cómo se controla este ítem</h3>
            <p className="mt-1 text-xs leading-5 text-[#858592]">
              La frecuencia decide en qué lista programada aparecerá. “Solo por solicitud” lo mantiene disponible para conteos puntuales sin ensuciar los cierres.
            </p>
          </div>
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
          <Field label={`Punto mínimo para alertar (${item.unit_name})`}>
            <input inputMode="decimal" value={lowStockThreshold} onChange={(event) => setLowStockThreshold(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label={`Objetivo después de reponer (${item.unit_name})`}>
            <input inputMode="decimal" value={targetStockUnits} onChange={(event) => setTargetStockUnits(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Vida útil en días">
            <input type="number" min="0" step="1" value={shelfLifeDays} onChange={(event) => setShelfLifeDays(event.target.value)} className={INPUT_CLASS} />
          </Field>
          <Field label="Frecuencia principal de conteo">
            <select value={countFrequency} onChange={(event) => setCountFrequency(event.target.value as typeof countFrequency)} className={INPUT_CLASS}>
              <option value="">Solo por solicitud</option>
              <option value="per_shift">Por turno</option>
              <option value="daily">Diaria</option>
              <option value="weekly">Semanal</option>
              <option value="biweekly">Quincenal</option>
              <option value="monthly">Mensual</option>
            </select>
          </Field>
          <Field label="Responsable del conteo">
            <select value={countRole} onChange={(event) => setCountRole(event.target.value as typeof countRole)} className={INPUT_CLASS}>
              <option value="">Seleccionar responsable</option>
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
        <button type="button" onClick={save} disabled={isPending || !item.is_active} className={`mt-4 ${PRIMARY_BUTTON}`}>
          {isPending ? 'Guardando…' : 'Guardar controles del ítem'}
        </button>
        </div>

        <ImpactCard title="Qué significa esta configuración">
          <ImpactLine
            label="Lista principal"
            value={item.primary_count_frequency ? frequencyLabel(item.primary_count_frequency) : 'Solo conteo solicitado'}
          />
          <ImpactLine label="Responsable" value={roleLabel(item.primary_count_role)} />
          <ImpactLine
            label="Alerta de mínimo"
            value={item.low_stock_threshold == null ? 'Pendiente de definir' : `${quantity(item.low_stock_threshold)} ${item.unit_name}`}
          />
          <ImpactLine
            label="Objetivo"
            value={item.target_stock_units == null ? 'Pendiente de definir' : `${quantity(item.target_stock_units)} ${item.unit_name}`}
          />
          <div className="my-3 border-t border-[#30303D]" />
          <div className="text-xs font-semibold uppercase tracking-[0.12em] text-[#777784]">Estructura protegida</div>
        <ImpactLine label="Estado" value={item.is_active ? 'Activo' : 'Borrador'} />
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
            {lines.map((line, index) => {
              const inputItem = items.find((candidate) => candidate.id === Number(line.inputInventoryItemId));
              return (
              <div key={line.key} className="grid gap-2 rounded-xl border border-[#292938] bg-[#101016] p-3 md:grid-cols-[1fr_180px_auto] md:items-end">
                <Field label={`Insumo ${index + 1}`}>
                  <select value={line.inputInventoryItemId} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, inputInventoryItemId: event.target.value } : candidate))} className={INPUT_CLASS}>
                    <option value="">Selecciona un ítem…</option>
                    {items.filter((candidate) => candidate.tracking_mode === 'transactional' && candidate.id !== outputItem.id).map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name} · disponible {quantity(candidate.current_stock_units)} {candidate.unit_name}</option>
                    ))}
                  </select>
                </Field>
                <Field label={`Cantidad consumida (${inputItem?.unit_name ?? 'unidad base'})`}>
                  <input inputMode="decimal" value={line.quantityUnits} onChange={(event) => setLines((current) => current.map((candidate) => candidate.key === line.key ? { ...candidate, quantityUnits: event.target.value } : candidate))} className={INPUT_CLASS} />
                </Field>
                <button type="button" disabled={lines.length === 1} onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))} className={`${SECONDARY_BUTTON} text-[#FB7185]`}>
                  Quitar
                </button>
              </div>
              );
            })}
          </div>

          <div className="mt-4">
            <Field label="Explicación del cambio">
              <textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} rows={3} className={INPUT_CLASS} placeholder="Ej. nueva presentación de 10 Bombys; consume 10 unidades crudas." />
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
                  v{recipe.version} · {quantity(recipe.output_quantity_units)} {recipe.output_unit_name} de salida · {recipe.lead_time_minutes} min
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
          <div key={`${recipe.id}:${component.input_inventory_item_id}`}>{quantity(component.quantity_units)} {component.unit_name} de {component.input_name}</div>
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

function ProfileFact({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'good' | 'neutral';
}) {
  return (
    <div className={`rounded-xl border p-3 ${tone === 'good' ? 'border-emerald-400/25 bg-emerald-400/5' : 'border-[#292938] bg-[#14141C]'}`}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#858591]">{label}</div>
      <div className={`mt-1 text-sm font-semibold ${tone === 'good' ? 'text-emerald-200' : 'text-white'}`}>{value}</div>
    </div>
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
