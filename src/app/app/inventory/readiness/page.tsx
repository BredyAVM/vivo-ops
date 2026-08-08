import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import {
  parseInventoryCutoverReadiness,
  type InventoryReadinessCheck,
  type InventoryRecipeActivationRow,
} from '@/lib/inventory/readiness';
import { inventoryDisplayText } from '../display';

const checkTones: Record<InventoryReadinessCheck['status'], string> = {
  pass: 'border-emerald-400/25 bg-emerald-400/5 text-emerald-100',
  pending: 'border-amber-400/25 bg-amber-400/5 text-amber-100',
  blocked: 'border-rose-400/25 bg-rose-400/5 text-rose-100',
  info: 'border-sky-400/25 bg-sky-400/5 text-sky-100',
};

const checkLabels: Record<InventoryReadinessCheck['status'], string> = {
  pass: 'Conforme',
  pending: 'Pendiente',
  blocked: 'Bloquea el corte',
  info: 'Informativo',
};

const recipeLabels: Record<InventoryRecipeActivationRow['status'], string> = {
  invalid: 'Requiere corrección',
  active: 'Activa',
  blocked_by_opening: 'Espera aperturas',
  ready_to_activate: 'Lista para activar',
};

export default async function InventoryReadinessPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data, error } = await ctx.supabase.rpc('inventory_cutover_readiness_v1');
  if (error) {
    throw new Error(`No se pudo auditar la preparación del inventario: ${error.message}`);
  }

  const readiness = parseInventoryCutoverReadiness(data);
  const structureChecks = readiness.checks.filter((check) => check.phase === 'structure');
  const operationChecks = readiness.checks.filter((check) => check.phase === 'operation');
  const statusTitle = readiness.operational_ready
    ? 'Listo para operación canónica'
    : readiness.structural_ready
      ? 'Estructura lista; apertura operativa pendiente'
      : 'Hay bloqueos de estructura por resolver';
  const bannerTone = readiness.operational_ready
    ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-50'
    : readiness.structural_ready
      ? 'border-amber-400/30 bg-amber-400/10 text-amber-50'
      : 'border-rose-400/30 bg-rose-400/10 text-rose-50';

  return (
    <section className="space-y-6">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-[#FEEF00]">
            Bloque 16
          </div>
          <h2 className="mt-1 text-2xl font-semibold">Preparación del corte canónico</h2>
          <p className="mt-1 max-w-4xl text-sm text-[#9696A3]">
            Auditoría en vivo de catálogo, recetas, aperturas, órdenes, permisos y guardas. Esta lectura no
            activa inventario, no mueve stock y no impide crear ni enviar órdenes.
          </p>
        </div>
        <div className="rounded-full border border-[#30303F] bg-[#15151D] px-3 py-1 text-xs text-[#C7C7D1]">
          Modo actual: {cutoverModeLabel(readiness.cutover_mode)}
        </div>
      </div>

      <div className={`rounded-2xl border p-5 ${bannerTone}`}>
        <div className="text-lg font-semibold">{statusTitle}</div>
        <p className="mt-1 text-sm opacity-90">
          {readiness.structural_ready
            ? 'Las reglas y dependencias existentes son coherentes. El cambio de autoridad sigue desactivado hasta completar los pasos operativos.'
            : 'Revise los controles marcados antes de iniciar cualquier apertura física.'}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="Productos activos"
          value={readiness.summary.active_products}
          detail={`${readiness.summary.ready_catalog_products}/${readiness.summary.catalog_products} del catálogo listos`}
        />
        <SummaryCard label="Vínculos canónicos" value={readiness.summary.canonical_links} detail="Versión 1 auditada" />
        <SummaryCard
          label="Aperturas"
          value={`${readiness.opening.accepted_count}/${readiness.opening.eligible_count}`}
          detail={`${readiness.opening.under_review_count} en revisión`}
        />
        <SummaryCard
          label="Recetas activas"
          value={`${readiness.recipes.active_count}/${readiness.recipes.canonical_count}`}
          detail="Activación gradual"
        />
        <SummaryCard
          label="Órdenes abiertas"
          value={readiness.orders.open_count}
          detail={`${readiness.orders.resolver_error_count} con error`}
        />
      </div>

      <CheckGroup
        title="1. Estructura técnica"
        description="Estos controles deben permanecer conformes antes y durante la apertura."
        checks={structureChecks}
      />
      <CheckGroup
        title="2. Preparación operativa"
        description="Son pasos reales del corte; no son errores del modelo."
        checks={operationChecks}
      />

      <div className="grid gap-5 xl:grid-cols-[1.1fr_0.9fr]">
        <section className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-semibold">Cola de recetas canónicas</h3>
              <p className="mt-1 text-sm text-[#92929F]">
                Cada receta se activa cuando sus insumos y su salida ya tienen apertura aceptada.
              </p>
            </div>
            <Link
              href="/app/inventory/recipes"
              prefetch={false}
              className="rounded-xl border border-[#3A3A48] px-3 py-2 text-sm text-[#E5E5EA] hover:border-[#FEEF00]/60"
            >
              Abrir producción
            </Link>
          </div>

          <div className="mt-4 divide-y divide-[#242433]">
            {readiness.recipes.activation_queue.map((recipe) => (
              <div
                key={recipe.id}
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <div className="text-sm font-medium">{inventoryDisplayText(recipe.output_name)}</div>
                  <div className="mt-0.5 text-xs text-[#858591]">
                    {recipe.lead_time_minutes === 0
                      ? 'Disponibilidad inmediata'
                      : `${recipe.lead_time_minutes / 60} h de preparación`}
                    {' · '}versión {recipe.version}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs font-semibold text-[#D6D6DE]">{recipeLabels[recipe.status]}</div>
                  {recipe.opening_blockers.length > 0 ? (
                    <div className="mt-1 max-w-md text-xs text-[#A0A0AC]">
                      Faltan: {recipe.opening_blockers
                        .map((item) => inventoryDisplayText(item.name))
                        .join(', ')}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-[#242433] bg-[#111117] p-5">
          <h3 className="font-semibold">Secuencia segura del corte</h3>
          <p className="mt-1 text-sm text-[#92929F]">
            La creación y agenda de órdenes continúan; la coordinación especial aplica solo a la ventana
            futura de apertura.
          </p>
          <ol className="mt-4 space-y-4 text-sm">
            <RunbookStep
              number="1"
              title="Confirmar estructura"
              detail="Todos los controles técnicos deben estar en verde y las órdenes abiertas deben resolver sin errores."
            />
            <RunbookStep
              number="2"
              title="Abrir ítems de recetas primero"
              detail="Contar y aceptar insumos y salidas de prefritos y salsas; activar cada receta apenas quede liberada."
            />
            <RunbookStep
              number="3"
              title="Cerrar reconteos"
              detail="Resolver diferencias y no dejar conteos ni preparaciones abiertas antes del último lote."
            />
            <RunbookStep
              number="4"
              title="Aceptar la última apertura"
              detail="Ese acto deriva el modo canónico. Durante la ventana no se cierran entregas, aunque las órdenes pueden seguir creándose."
            />
            <RunbookStep
              number="5"
              title="Verificar y observar"
              detail="Probar lectura de Master, operación de Cocina y consumo por entrega antes de retirar cualquier escritor legado."
            />
          </ol>
          <Link
            href="/app/inventory/opening"
            prefetch={false}
            className="mt-5 inline-flex rounded-xl bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-black"
          >
            Ver apertura física
          </Link>
        </section>
      </div>

      <section className="rounded-2xl border border-sky-400/20 bg-sky-400/5 p-5">
        <h3 className="font-semibold text-sky-100">Orden de integración con los otros módulos</h3>
        <div className="mt-3 grid gap-3 text-sm text-sky-50/90 md:grid-cols-2 xl:grid-cols-4">
          <IntegrationCard number="1" title="Master" detail="Lectura compacta de stock, compromisos, alertas y último conteo." />
          <IntegrationCard number="2" title="Cocina" detail="Entradas, producción, conteos y pérdidas mediante comandos canónicos." />
          <IntegrationCard number="3" title="Asesor" detail="Fecha primero y disponibilidad informativa; siempre puede enviar al Master." />
          <IntegrationCard number="4" title="Counter" detail="Fecha primero y la misma alerta no bloqueante; la entrega consume por el motor central." />
        </div>
      </section>
    </section>
  );
}

function cutoverModeLabel(mode: 'legacy' | 'opening' | 'canonical') {
  if (mode === 'canonical') return 'Canónico';
  if (mode === 'opening') return 'Apertura';
  return 'Legado';
}

function SummaryCard({ label, value, detail }: { label: string; value: number | string; detail: string }) {
  return (
    <div className="rounded-2xl border border-[#242433] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-white">{value}</div>
      <div className="mt-1 text-xs text-[#858591]">{detail}</div>
    </div>
  );
}

function CheckGroup({ title, description, checks }: {
  title: string;
  description: string;
  checks: InventoryReadinessCheck[];
}) {
  return (
    <section>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-1 text-sm text-[#8D8D99]">{description}</p>
      <div className="mt-3 grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {checks.map((check) => (
          <article key={check.code} className={`rounded-2xl border p-4 ${checkTones[check.status]}`}>
            <div className="flex items-start justify-between gap-3">
              <h4 className="font-semibold">{check.title}</h4>
              <span className="whitespace-nowrap rounded-full border border-current/20 px-2 py-0.5 text-[11px] font-semibold">
                {checkLabels[check.status]}
              </span>
            </div>
            <p className="mt-2 text-sm opacity-85">{check.detail}</p>
            {check.current != null && check.required != null ? (
              <div className="mt-3 text-xs font-semibold opacity-75">{check.current} / {check.required}</div>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function RunbookStep({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#FEEF00] text-xs font-bold text-black">
        {number}
      </span>
      <div>
        <div className="font-semibold text-[#EEEEF2]">{title}</div>
        <div className="mt-0.5 text-[#9696A3]">{detail}</div>
      </div>
    </li>
  );
}

function IntegrationCard({ number, title, detail }: { number: string; title: string; detail: string }) {
  return (
    <div className="rounded-xl border border-sky-300/15 bg-[#0E151B] p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-sky-300">{number}. {title}</div>
      <p className="mt-1 text-xs leading-relaxed text-sky-50/75">{detail}</p>
    </div>
  );
}
