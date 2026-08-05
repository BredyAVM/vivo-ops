import { getAuthContext } from '@/lib/auth';

type RawRecipe = {
  id: number;
  output_inventory_item_id: number;
  recipe_kind: 'production' | 'packaging';
  output_quantity_units: number | string;
  notes: string | null;
  is_active: boolean;
  lead_time_minutes: number;
  production_multiple: number | string;
  version: number;
};

type RawRecipeComponent = {
  recipe_id: number;
  input_inventory_item_id: number;
  quantity_units: number | string;
  sort_order: number;
};

type RawInventoryItem = {
  id: number;
  name: string;
  unit_name: string;
  availability_mode: string | null;
};

type RecipeComponentView = {
  inventoryItemId: number;
  inventoryItemName: string;
  quantityUnits: number;
  unitName: string;
  sortOrder: number;
};

type RecipeView = {
  id: number;
  outputInventoryItemId: number;
  outputInventoryItemName: string;
  outputUnitName: string;
  recipeKind: 'production' | 'packaging';
  outputQuantityUnits: number;
  notes: string | null;
  isActive: boolean;
  leadTimeMinutes: number;
  productionMultiple: number;
  version: number;
  availabilityMode: string | null;
  components: RecipeComponentView[];
  isCanonicalStaged: boolean;
};

const availabilityLabels: Record<string, string> = {
  on_hand_only: 'Solo existencia real',
  immediate_recipe: 'Disponibilidad inmediata',
  scheduled_recipe: 'Disponibilidad programada',
};

function formatQuantity(value: number) {
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits: 3 }).format(value);
}

function recipeKindLabel(kind: RecipeView['recipeKind']) {
  return kind === 'packaging' ? 'Porcionado / empaque' : 'Preparación';
}

function timingLabel(recipe: RecipeView) {
  if (recipe.leadTimeMinutes === 0) return 'Inmediata';
  const hours = recipe.leadTimeMinutes / 60;
  return `${formatQuantity(hours)} h`;
}

export default async function InventoryRecipesPage() {
  const ctx = await getAuthContext();

  if (!ctx) {
    return null;
  }

  const [recipesResult, componentsResult, itemsResult] = await Promise.all([
    ctx.supabase
      .from('inventory_recipes')
      .select(`
        id,
        output_inventory_item_id,
        recipe_kind,
        output_quantity_units,
        notes,
        is_active,
        lead_time_minutes,
        production_multiple,
        version
      `)
      .order('output_inventory_item_id', { ascending: true })
      .order('version', { ascending: false }),
    ctx.supabase
      .from('inventory_recipe_components')
      .select('recipe_id, input_inventory_item_id, quantity_units, sort_order')
      .order('recipe_id', { ascending: true })
      .order('sort_order', { ascending: true }),
    ctx.supabase
      .from('inventory_items')
      .select('id, name, unit_name, availability_mode'),
  ]);

  const firstError = recipesResult.error ?? componentsResult.error ?? itemsResult.error;

  if (firstError) {
    throw new Error(`No se pudo cargar el catálogo de recetas: ${firstError.message}`);
  }

  const rawRecipes = (recipesResult.data ?? []) as RawRecipe[];
  const rawComponents = (componentsResult.data ?? []) as RawRecipeComponent[];
  const rawItems = (itemsResult.data ?? []) as RawInventoryItem[];
  const itemById = new Map(rawItems.map((item) => [Number(item.id), item]));
  const componentsByRecipeId = new Map<number, RecipeComponentView[]>();

  for (const component of rawComponents) {
    const recipeId = Number(component.recipe_id);
    const item = itemById.get(Number(component.input_inventory_item_id));
    const components = componentsByRecipeId.get(recipeId) ?? [];

    components.push({
      inventoryItemId: Number(component.input_inventory_item_id),
      inventoryItemName: item?.name ?? `Ítem #${component.input_inventory_item_id}`,
      quantityUnits: Number(component.quantity_units),
      unitName: item?.unit_name ?? 'unidad',
      sortOrder: Number(component.sort_order),
    });
    componentsByRecipeId.set(recipeId, components);
  }

  const recipes: RecipeView[] = rawRecipes.map((recipe) => {
    const outputItem = itemById.get(Number(recipe.output_inventory_item_id));

    return {
      id: Number(recipe.id),
      outputInventoryItemId: Number(recipe.output_inventory_item_id),
      outputInventoryItemName:
        outputItem?.name ?? `Ítem #${recipe.output_inventory_item_id}`,
      outputUnitName: outputItem?.unit_name ?? 'unidad',
      recipeKind: recipe.recipe_kind,
      outputQuantityUnits: Number(recipe.output_quantity_units),
      notes: recipe.notes,
      isActive: recipe.is_active,
      leadTimeMinutes: Number(recipe.lead_time_minutes),
      productionMultiple: Number(recipe.production_multiple),
      version: Number(recipe.version),
      availabilityMode: outputItem?.availability_mode ?? null,
      components: componentsByRecipeId.get(Number(recipe.id)) ?? [],
      isCanonicalStaged: recipe.notes?.startsWith('Bloque 3:') ?? false,
    };
  });

  const canonicalRecipes = recipes.filter((recipe) => recipe.isCanonicalStaged);
  const legacyRecipes = recipes.filter((recipe) => !recipe.isCanonicalStaged);
  const scheduledCount = canonicalRecipes.filter((recipe) => recipe.leadTimeMinutes > 0).length;
  const immediateCount = canonicalRecipes.length - scheduledCount;

  return (
    <>
      <section>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Recetas canónicas</h2>
            <p className="mt-1 max-w-3xl text-sm text-[#9696A3]">
              Transformaciones de crudos, prefritos y salsas. Están preparadas para el motor
              atómico, pero no pueden ejecutarse todavía.
            </p>
          </div>
          <div className="rounded-full border border-[#2B2B38] px-3 py-1 text-xs text-[#9D9DA9]">
            Solo lectura · Sin movimientos
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <SummaryCard label="Canónicas" value={canonicalRecipes.length} tone="good" />
          <SummaryCard label="Programadas" value={scheduledCount} detail="4 horas" tone="info" />
          <SummaryCard label="Inmediatas" value={immediateCount} tone="info" />
          <SummaryCard
            label="Heredadas activas"
            value={legacyRecipes.filter((recipe) => recipe.isActive).length}
            detail="Sin modificaciones"
            tone="warn"
          />
        </div>
      </section>

      <section className="mt-6 grid gap-4 xl:grid-cols-2">
        {canonicalRecipes.map((recipe) => (
          <article
            key={recipe.id}
            className="rounded-2xl border border-[#242433] bg-[#111117] p-5"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-[#FEEF00]">
                  {recipeKindLabel(recipe.recipeKind)}
                </div>
                <h3 className="mt-1 text-lg font-semibold">{recipe.outputInventoryItemName}</h3>
                <div className="mt-1 text-xs text-[#7F7F8C]">
                  Receta #{recipe.id} · versión {recipe.version} · preparada, no ejecutable
                </div>
              </div>
              <div className="rounded-xl border border-[#30303E] bg-[#0B0B0D] px-3 py-2 text-right text-xs">
                <div className="text-[#8F8F9C]">Tiempo</div>
                <div className="mt-1 font-semibold text-[#7DD3FC]">{timingLabel(recipe)}</div>
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-[#242433] bg-[#0D0D12] p-3">
              <div className="text-xs uppercase tracking-wide text-[#7F7F8C]">Consume</div>
              <ul className="mt-2 space-y-1.5 text-sm text-[#D5D5DE]">
                {recipe.components.map((component) => (
                  <li key={component.inventoryItemId}>
                    {formatQuantity(component.quantityUnits)} {component.unitName} ·{' '}
                    {component.inventoryItemName}
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div className="text-xs text-[#7F7F8C]">Produce</div>
                <div className="mt-1 text-[#D5D5DE]">
                  {formatQuantity(recipe.outputQuantityUnits)} {recipe.outputUnitName}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#7F7F8C]">Disponibilidad</div>
                <div className="mt-1 text-[#D5D5DE]">
                  {availabilityLabels[recipe.availabilityMode ?? ''] ?? 'Según receta'}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#7F7F8C]">Múltiplo</div>
                <div className="mt-1 text-[#D5D5DE]">
                  {formatQuantity(recipe.productionMultiple)}
                </div>
              </div>
              <div>
                <div className="text-xs text-[#7F7F8C]">Estado operativo</div>
                <div className="mt-1 text-[#FBBF24]">No activa</div>
              </div>
            </div>
          </article>
        ))}
      </section>

      <details className="mt-6 rounded-2xl border border-[#3A3020] bg-[#17130D] p-4">
        <summary className="cursor-pointer text-sm font-semibold text-[#FBBF24]">
          Ver las {legacyRecipes.length} recetas heredadas que Máster conoce actualmente
        </summary>
        <div className="mt-4 space-y-3">
          {legacyRecipes.map((recipe) => (
            <div key={recipe.id} className="rounded-xl border border-[#3A3020] bg-[#0F0D09] p-3">
              <div className="font-semibold">{recipe.outputInventoryItemName}</div>
              <div className="mt-1 text-xs text-[#B8A98B]">
                #{recipe.id} · {recipeKindLabel(recipe.recipeKind)} · versión {recipe.version} ·{' '}
                {recipe.isActive ? 'activa en el motor heredado' : 'inactiva'}
              </div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: number;
  detail?: string;
  tone?: 'default' | 'good' | 'info' | 'warn';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-[#86EFAC]',
    info: 'text-[#7DD3FC]',
    warn: 'text-[#FBBF24]',
  }[tone];

  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
      {detail ? <div className="mt-1 text-xs text-[#7F7F8C]">{detail}</div> : null}
    </div>
  );
}
