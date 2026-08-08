'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  activateInventoryRecipeAction,
  completeInventoryProductionAction,
  resolveInventoryProductionAction,
  startInventoryProductionAction,
} from '../actions';

export type ProductionComponent = {
  inventory_item_id: number;
  name: string;
  unit_name: string;
  quantity_units: number;
  current_stock_units: number;
  initialized: boolean;
};

export type ProductionRecipe = {
  id: number;
  recipe_kind: 'production' | 'packaging';
  is_active: boolean;
  notes: string | null;
  lead_time_minutes: number;
  production_multiple: number;
  output_quantity_units: number;
  output_inventory_item_id: number;
  output_name: string;
  output_unit_name: string;
  output_current_stock_units: number;
  output_availability_mode: string | null;
  output_target_stock_units: number | null;
  activation_blockers: string[];
  components: ProductionComponent[];
};

export type ProductionBatch = {
  id: number;
  recipe_id: number;
  output_inventory_item_id: number;
  output_name: string;
  output_unit_name: string;
  expected_output_units: number;
  available_at: string;
  is_ready: boolean;
  status: string;
  notes: string | null;
  created_at: string;
  capture_details: Record<string, unknown>;
};

export type RecentProductionBatch = {
  id: number;
  output_name: string;
  output_unit_name: string;
  expected_output_units: number;
  actual_output_units: number | null;
  difference_quantity_units: number | null;
  status: 'fulfilled' | 'failed' | 'cancelled';
  resolved_at: string | null;
  notes: string | null;
};

export type InventoryProductionWorkspace = {
  permissions: {
    can_activate: boolean;
    can_start: boolean;
    can_complete: boolean;
    can_fail: boolean;
    can_cancel: boolean;
  };
  recipes: ProductionRecipe[];
  active_batches: ProductionBatch[];
  recent_batches: RecentProductionBatch[];
  recent_lots: Array<Record<string, unknown>>;
  summary: {
    canonical_recipes: number;
    active_recipes: number;
    cooling_batches: number;
    ready_batches: number;
    yield_variances: number;
  };
};

type RecipeDraft = {
  batchMultiplier: string;
  actualOutputUnits: string;
  notes: string;
};

type BatchDraft = {
  actualOutputUnits: string;
  notes: string;
};

const INPUT_CLASS = 'w-full rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-sm text-white outline-none focus:border-[#FEEF00]/70';
const PRIMARY_BUTTON_CLASS = 'rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-black transition hover:bg-[#FFF34D]';
const SECONDARY_BUTTON_CLASS = 'rounded-xl border border-[#343442] bg-[#17171F] px-4 py-2 text-sm font-semibold text-[#D5D5DE] transition hover:border-[#FEEF00]/50';

function quantity(value: unknown) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(Number(value ?? 0));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function recipeTiming(recipe: ProductionRecipe) {
  if (recipe.lead_time_minutes === 0) return 'Inmediata';
  return `${quantity(recipe.lead_time_minutes / 60)} h`;
}

function statusLabel(status: RecentProductionBatch['status']) {
  if (status === 'fulfilled') return 'Terminada';
  if (status === 'failed') return 'Fallida';
  return 'Anulada';
}

export default function InventoryProductionWorkspaceClient({
  workspace,
}: {
  workspace: InventoryProductionWorkspace;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recipeDrafts, setRecipeDrafts] = useState<Record<number, RecipeDraft>>(() =>
    Object.fromEntries(
      workspace.recipes.map((recipe) => {
        const multiplier = recipe.production_multiple;
        return [
          recipe.id,
          {
            batchMultiplier: String(multiplier),
            actualOutputUnits: String(recipe.output_quantity_units * multiplier),
            notes: '',
          },
        ];
      }),
    ),
  );
  const [batchDrafts, setBatchDrafts] = useState<Record<number, BatchDraft>>(() =>
    Object.fromEntries(
      workspace.active_batches.map((batch) => [
        batch.id,
        { actualOutputUnits: String(batch.expected_output_units), notes: '' },
      ]),
    ),
  );

  const scheduledRecipes = workspace.recipes.filter((recipe) => recipe.lead_time_minutes > 0);
  const immediateRecipes = workspace.recipes.filter((recipe) => recipe.lead_time_minutes === 0);

  function runAction(key: string, successMessage: string, action: () => Promise<unknown>) {
    setPendingKey(key);
    setNotice(null);
    setError(null);
    startTransition(async () => {
      try {
        await action();
        setNotice(successMessage);
        router.refresh();
      } catch (actionError) {
        setError(actionError instanceof Error ? actionError.message : 'No se pudo completar la operación.');
      } finally {
        setPendingKey(null);
      }
    });
  }

  function updateRecipeDraft(recipe: ProductionRecipe, patch: Partial<RecipeDraft>) {
    setRecipeDrafts((current) => {
      const existing = current[recipe.id];
      const next = { ...existing, ...patch };
      if (patch.batchMultiplier != null) {
        const multiplier = Number(patch.batchMultiplier);
        if (Number.isFinite(multiplier) && multiplier > 0) {
          next.actualOutputUnits = String(multiplier * recipe.output_quantity_units);
        }
      }
      return { ...current, [recipe.id]: next };
    });
  }

  function activateRecipe(recipe: ProductionRecipe) {
    runAction(
      `activate-${recipe.id}`,
      `${recipe.output_name} quedó activa para producción.`,
      () => activateInventoryRecipeAction({ recipeId: recipe.id }),
    );
  }

  function startRecipe(recipe: ProductionRecipe) {
    const draft = recipeDrafts[recipe.id];
    const batchMultiplier = Number(draft.batchMultiplier);
    const declaredOutputUnits = recipe.lead_time_minutes === 0
      ? Number(draft.actualOutputUnits)
      : null;
    runAction(
      `start-${recipe.id}`,
      recipe.lead_time_minutes === 0
        ? `${recipe.output_name} se registró como disponible.`
        : `${recipe.output_name} quedó en preparación y todavía no está disponible.`,
      () => startInventoryProductionAction({
        operationId: crypto.randomUUID(),
        recipeId: recipe.id,
        batchMultiplier,
        declaredOutputUnits,
        notes: draft.notes,
      }),
    );
  }

  function completeBatch(batch: ProductionBatch) {
    const draft = batchDrafts[batch.id] ?? {
      actualOutputUnits: String(batch.expected_output_units),
      notes: '',
    };
    runAction(
      `complete-${batch.id}`,
      `${batch.output_name} se agregó al stock con el rendimiento declarado.`,
      () => completeInventoryProductionAction({
        operationId: crypto.randomUUID(),
        productionFlowId: batch.id,
        actualOutputUnits: Number(draft.actualOutputUnits),
        notes: draft.notes,
      }),
    );
  }

  function resolveBatch(batch: ProductionBatch, resolution: 'failed' | 'cancelled') {
    const warning = resolution === 'failed'
      ? 'La producción quedará fallida y los insumos ya consumidos no regresarán automáticamente. ¿Continuar?'
      : 'La producción quedará anulada. Los insumos solo regresan mediante un reverso administrativo explícito. ¿Continuar?';
    if (!window.confirm(warning)) return;
    const draft = batchDrafts[batch.id];
    runAction(
      `${resolution}-${batch.id}`,
      resolution === 'failed' ? 'La producción quedó reportada como fallida.' : 'La producción quedó anulada.',
      () => resolveInventoryProductionAction({
        productionFlowId: batch.id,
        resolution,
        notes: draft?.notes,
      }),
    );
  }

  return (
    <div>
      <section>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Producción y transformaciones</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
              Las recetas inmediatas entran al stock al registrarse. Los prefritos permanecen en
              preparación hasta completar su tiempo y declarar el rendimiento físico real.
            </p>
          </div>
          <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
            Bloque 12 · Centro canónico
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
          <SummaryCard label="Recetas" value={workspace.summary.canonical_recipes} />
          <SummaryCard label="Activas" value={workspace.summary.active_recipes} tone="good" />
          <SummaryCard label="En preparación" value={workspace.summary.cooling_batches} tone="info" />
          <SummaryCard label="Listas por cerrar" value={workspace.summary.ready_batches} tone="warn" />
          <SummaryCard label="Diferencias de rendimiento" value={workspace.summary.yield_variances} tone="danger" />
        </div>

        {!workspace.permissions.can_start ? (
          <div className="mt-4 rounded-xl border border-[#2B2B38] bg-[#111117] px-4 py-3 text-sm text-[#A6A6B2]">
            Vista de Master: puedes revisar tiempos, existencias y rendimientos, pero solo Cocina o
            Administración registran producción.
          </div>
        ) : null}
        {notice ? <Feedback tone="good">{notice}</Feedback> : null}
        {error ? <Feedback tone="danger">{error}</Feedback> : null}
      </section>

      <section className="mt-6 rounded-2xl border border-[#242433] bg-[#111117] p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Producciones en curso</h3>
            <p className="mt-1 text-xs text-[#858591]">
              El stock de salida se mantiene en cero hasta declarar la terminación.
            </p>
          </div>
          <span className="text-sm font-semibold text-[#7DD3FC]">{workspace.active_batches.length}</span>
        </div>

        {workspace.active_batches.length ? (
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {workspace.active_batches.map((batch) => {
              const draft = batchDrafts[batch.id] ?? {
                actualOutputUnits: String(batch.expected_output_units),
                notes: '',
              };
              return (
                <article key={batch.id} className="rounded-xl border border-[#2A2A39] bg-[#0D0D12] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="font-semibold">{batch.output_name}</div>
                      <div className="mt-1 text-xs text-[#8F8F9C]">
                        Esperado: {quantity(batch.expected_output_units)} {batch.output_unit_name}
                      </div>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${batch.is_ready ? 'bg-[#3A2F0B] text-[#FBBF24]' : 'bg-[#102A36] text-[#7DD3FC]'}`}>
                      {batch.is_ready ? 'Lista para cerrar' : 'En preparación'}
                    </span>
                  </div>
                  <div className="mt-3 text-sm text-[#C4C4CE]">
                    Disponible desde {formatDate(batch.available_at)}
                  </div>
                  {workspace.permissions.can_complete ? (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <Field label="Salida física real">
                        <input
                          value={draft.actualOutputUnits}
                          onChange={(event) => setBatchDrafts((current) => ({
                            ...current,
                            [batch.id]: { ...draft, actualOutputUnits: event.target.value },
                          }))}
                          inputMode="decimal"
                          className={INPUT_CLASS}
                        />
                      </Field>
                      <Field label="Nota opcional">
                        <input
                          value={draft.notes}
                          onChange={(event) => setBatchDrafts((current) => ({
                            ...current,
                            [batch.id]: { ...draft, notes: event.target.value },
                          }))}
                          className={INPUT_CLASS}
                        />
                      </Field>
                      <div className="flex flex-wrap gap-2 sm:col-span-2">
                        <button
                          type="button"
                          disabled={!batch.is_ready || isPending}
                          onClick={() => completeBatch(batch)}
                          className={`${PRIMARY_BUTTON_CLASS} disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          {pendingKey === `complete-${batch.id}` ? 'Registrando…' : 'Terminar y acreditar stock'}
                        </button>
                        {workspace.permissions.can_fail ? (
                          <button type="button" disabled={isPending} onClick={() => resolveBatch(batch, 'failed')} className={SECONDARY_BUTTON_CLASS}>
                            Reportar fallida
                          </button>
                        ) : null}
                        {workspace.permissions.can_cancel ? (
                          <button type="button" disabled={isPending} onClick={() => resolveBatch(batch, 'cancelled')} className={`${SECONDARY_BUTTON_CLASS} text-[#FB7185]`}>
                            Anular captura
                          </button>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-[#30303E] px-4 py-8 text-center text-sm text-[#858591]">
            No hay producciones en curso.
          </div>
        )}
      </section>

      <RecipeSection
        title="Prefritos y preparaciones con espera"
        description="Consumen crudo al comenzar y entran al stock después del tiempo configurado."
        recipes={scheduledRecipes}
        recipeDrafts={recipeDrafts}
        permissions={workspace.permissions}
        isPending={isPending}
        pendingKey={pendingKey}
        onUpdate={updateRecipeDraft}
        onActivate={activateRecipe}
        onStart={startRecipe}
      />

      <RecipeSection
        title="Salsas y transformaciones inmediatas"
        description="La salida física declarada queda disponible en la misma operación."
        recipes={immediateRecipes}
        recipeDrafts={recipeDrafts}
        permissions={workspace.permissions}
        isPending={isPending}
        pendingKey={pendingKey}
        onUpdate={updateRecipeDraft}
        onActivate={activateRecipe}
        onStart={startRecipe}
      />

      {workspace.recent_batches.length ? (
        <section className="mt-6 overflow-hidden rounded-2xl border border-[#242433] bg-[#111117]">
          <div className="border-b border-[#242433] px-5 py-4">
            <h3 className="font-semibold">Producciones resueltas recientemente</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-[#16161F] text-xs uppercase tracking-wide text-[#8F8F9C]">
                <tr>
                  <th className="px-4 py-3">Producto</th>
                  <th className="px-4 py-3">Estado</th>
                  <th className="px-4 py-3">Esperado</th>
                  <th className="px-4 py-3">Real</th>
                  <th className="px-4 py-3">Diferencia</th>
                  <th className="px-4 py-3">Cierre</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#242433]">
                {workspace.recent_batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="px-4 py-3 font-medium">{batch.output_name}</td>
                    <td className="px-4 py-3">{statusLabel(batch.status)}</td>
                    <td className="px-4 py-3">{quantity(batch.expected_output_units)}</td>
                    <td className="px-4 py-3">{batch.actual_output_units == null ? '—' : quantity(batch.actual_output_units)}</td>
                    <td className="px-4 py-3">{batch.difference_quantity_units == null ? '—' : quantity(batch.difference_quantity_units)}</td>
                    <td className="px-4 py-3 text-[#A6A6B2]">{batch.resolved_at ? formatDate(batch.resolved_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RecipeSection({
  title,
  description,
  recipes,
  recipeDrafts,
  permissions,
  isPending,
  pendingKey,
  onUpdate,
  onActivate,
  onStart,
}: {
  title: string;
  description: string;
  recipes: ProductionRecipe[];
  recipeDrafts: Record<number, RecipeDraft>;
  permissions: InventoryProductionWorkspace['permissions'];
  isPending: boolean;
  pendingKey: string | null;
  onUpdate: (recipe: ProductionRecipe, patch: Partial<RecipeDraft>) => void;
  onActivate: (recipe: ProductionRecipe) => void;
  onStart: (recipe: ProductionRecipe) => void;
}) {
  return (
    <section className="mt-6">
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[#8F8F9C]">{description}</p>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {recipes.map((recipe) => {
          const draft = recipeDrafts[recipe.id];
          const hasBlockers = recipe.activation_blockers.length > 0;
          const canExecute = recipe.is_active && !hasBlockers && permissions.can_start;
          const multiplier = Number(draft.batchMultiplier);
          return (
            <article key={recipe.id} className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[#FEEF00]">
                    {recipe.recipe_kind === 'packaging' ? 'Porcionado' : 'Preparación'}
                  </div>
                  <h4 className="mt-1 text-lg font-semibold">{recipe.output_name}</h4>
                  <div className="mt-1 text-xs text-[#7F7F8C]">Receta #{recipe.id}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-[#858591]">Tiempo</div>
                  <div className="mt-1 font-semibold text-[#7DD3FC]">{recipeTiming(recipe)}</div>
                </div>
              </div>

              <div className="mt-4 rounded-xl border border-[#242433] bg-[#0D0D12] p-3">
                <div className="text-xs uppercase tracking-wide text-[#7F7F8C]">Consume por múltiplo</div>
                <ul className="mt-2 space-y-1.5 text-sm text-[#D5D5DE]">
                  {recipe.components.map((component) => (
                    <li key={component.inventory_item_id} className="flex justify-between gap-3">
                      <span>{component.name}</span>
                      <span className="text-right text-[#A6A6B2]">
                        {quantity(component.quantity_units * (Number.isFinite(multiplier) ? multiplier : 0))} {component.unit_name}
                        {' · '}hay {quantity(component.current_stock_units)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <Metric label="Existencia de salida" value={`${quantity(recipe.output_current_stock_units)} ${recipe.output_unit_name}`} />
                <Metric label="Estado" value={recipe.is_active ? 'Activa' : 'En espera'} tone={recipe.is_active ? 'good' : 'warn'} />
              </div>

              {hasBlockers ? (
                <div className="mt-4 rounded-xl border border-[#3A3020] bg-[#17130D] p-3 text-xs leading-5 text-[#D6B875]">
                  Requiere apertura aceptada y activación de: {recipe.activation_blockers.join(', ')}.
                </div>
              ) : null}

              {permissions.can_activate && !recipe.is_active ? (
                <button
                  type="button"
                  disabled={hasBlockers || isPending}
                  onClick={() => onActivate(recipe)}
                  className={`${SECONDARY_BUTTON_CLASS} mt-4 disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {pendingKey === `activate-${recipe.id}` ? 'Activando…' : 'Activar receta'}
                </button>
              ) : null}

              {permissions.can_start ? (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Field label={recipe.lead_time_minutes > 0 ? 'Servicios a preparar' : 'Multiplicador de receta'}>
                    <input
                      value={draft.batchMultiplier}
                      onChange={(event) => onUpdate(recipe, { batchMultiplier: event.target.value })}
                      inputMode="decimal"
                      className={INPUT_CLASS}
                    />
                  </Field>
                  {recipe.lead_time_minutes === 0 ? (
                    <Field label={`Salida física (${recipe.output_unit_name})`}>
                      <input
                        value={draft.actualOutputUnits}
                        onChange={(event) => onUpdate(recipe, { actualOutputUnits: event.target.value })}
                        inputMode="decimal"
                        className={INPUT_CLASS}
                      />
                    </Field>
                  ) : (
                    <Metric
                      label="Salida esperada"
                      value={`${quantity(recipe.output_quantity_units * (Number.isFinite(multiplier) ? multiplier : 0))} ${recipe.output_unit_name}`}
                    />
                  )}
                  <Field label="Nota opcional">
                    <input
                      value={draft.notes}
                      onChange={(event) => onUpdate(recipe, { notes: event.target.value })}
                      className={INPUT_CLASS}
                    />
                  </Field>
                  <div className="flex items-end">
                    <button
                      type="button"
                      disabled={!canExecute || isPending}
                      onClick={() => onStart(recipe)}
                      className={`${PRIMARY_BUTTON_CLASS} w-full disabled:cursor-not-allowed disabled:opacity-40`}
                    >
                      {pendingKey === `start-${recipe.id}`
                        ? 'Registrando…'
                        : recipe.lead_time_minutes > 0
                          ? 'Iniciar preparación'
                          : 'Registrar y acreditar'}
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function SummaryCard({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'good' | 'info' | 'warn' | 'danger' }) {
  const classes = { default: 'text-white', good: 'text-[#86EFAC]', info: 'text-[#7DD3FC]', warn: 'text-[#FBBF24]', danger: 'text-[#FB7185]' };
  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${classes[tone]}`}>{value}</div>
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'good' | 'warn' }) {
  const classes = { default: 'text-[#D5D5DE]', good: 'text-[#86EFAC]', warn: 'text-[#FBBF24]' };
  return (
    <div>
      <div className="text-xs text-[#7F7F8C]">{label}</div>
      <div className={`mt-1 ${classes[tone]}`}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs text-[#8F8F9C]">
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Feedback({ tone, children }: { tone: 'good' | 'danger'; children: React.ReactNode }) {
  return (
    <div className={`mt-4 rounded-xl border px-4 py-3 text-sm ${tone === 'good' ? 'border-[#24593A] bg-[#102419] text-[#86EFAC]' : 'border-[#5A2634] bg-[#241017] text-[#FB7185]'}`}>
      {children}
    </div>
  );
}
