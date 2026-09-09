'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

const PLAY_KINDS = ['anniversary', 'loyalty', 'new_client', 'reconnect', 'seasonal', 'custom'] as const;
const FULFILLMENT_FILTERS = ['any', 'pickup', 'delivery'] as const;
const ANNIVERSARY_MODES = ['any', 'include', 'exclude'] as const;
const BENEFIT_PRODUCT_TYPES = ['product', 'combo', 'promo', 'gambit', 'service'] as const;
const BENEFIT_SELECTION_MODES = ['single', 'multiple'] as const;
const PURCHASE_REQUIREMENT_MODES = ['none', 'minimum_order'] as const;
const OVERLAP_POLICIES = ['exclusive', 'selected_compatible'] as const;
const BENEFIT_STACK_POLICIES = ['one_per_order', 'allow_multiple'] as const;

export type PlayKind = (typeof PLAY_KINDS)[number];
export type PlayFulfillmentFilter = (typeof FULFILLMENT_FILTERS)[number];
export type PlayAnniversaryMode = (typeof ANNIVERSARY_MODES)[number];
export type PlayBenefitSelectionMode = (typeof BENEFIT_SELECTION_MODES)[number];
export type PlayPurchaseRequirementMode = (typeof PURCHASE_REQUIREMENT_MODES)[number];
export type PlayOverlapPolicy = (typeof OVERLAP_POLICIES)[number];
export type PlayBenefitStackPolicy = (typeof BENEFIT_STACK_POLICIES)[number];

export type PlayBenefitInput = {
  productId: number;
  quantity: number;
  unitBenefitValueUsd: number;
  unitAdvisorCostUsd: number;
  unitCompanyCostUsd: number;
  upgradeProductIds: number[];
};

export type SavePlayDraftInput = {
  playId?: number | null;
  name: string;
  description?: string;
  advisorGuidance?: string;
  messageTemplate?: string;
  kind: PlayKind;
  startsOn: string;
  endsOn: string;
  plannedBudgetUsd?: number | null;
  benefits: PlayBenefitInput[];
  benefitSelectionMode: PlayBenefitSelectionMode;
  purchaseRequirementMode: PlayPurchaseRequirementMode;
  minimumOrderAmountUsd?: number | null;
  overlapPolicy: PlayOverlapPolicy;
  compatiblePlayIds?: number[];
  benefitStackPolicy: PlayBenefitStackPolicy;
  evaluationWindowDays: number;
  metricWindow: number;
  minPurchaseCount: number;
  maxPurchaseCount?: number | null;
  minNetRevenueUsd: number;
  minDaysSincePurchase?: number | null;
  maxDaysSincePurchase?: number | null;
  firstPurchaseFrom?: string;
  firstPurchaseTo?: string;
  lastPurchaseFrom?: string;
  lastPurchaseTo?: string;
  lastGiftFrom?: string;
  lastGiftTo?: string;
  includeNeverGifted?: boolean;
  anniversaryMode: PlayAnniversaryMode;
  anniversaryMonth?: number | null;
  fulfillment: PlayFulfillmentFilter;
};

export type PlayActionResult = {
  ok: boolean;
  playId?: number;
  message?: string;
  error?: string;
};

export type PlayLifecycleCommand = 'pause' | 'resume' | 'close';

export type AmendPublishedPlayMessageInput = {
  playId: number;
  messageTemplate?: string;
  advisorGuidance?: string;
  reason: string;
};

export type AddManualPlayMemberInput = {
  playId: number;
  clientId: number;
  advisorId: string;
  reason: string;
};

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function finiteNumber(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNonNegativeInteger(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Math.trunc(finiteNumber(value, Number.NaN));
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Uno de los límites numéricos no es válido.');
  return parsed;
}

function dateKey(value: unknown, label: string, required = false) {
  const text = cleanText(value, 10);
  if (!text && !required) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T12:00:00-04:00`))) {
    throw new Error(`${label} no tiene una fecha válida.`);
  }
  return text;
}

function startBoundary(date: string) {
  return `${date}T00:00:00-04:00`;
}

function endBoundary(date: string) {
  return `${date}T23:59:59.999-04:00`;
}

function normalizeKind(value: unknown): PlayKind {
  return PLAY_KINDS.includes(value as PlayKind) ? (value as PlayKind) : 'custom';
}

function normalizeFulfillment(value: unknown): PlayFulfillmentFilter {
  return FULFILLMENT_FILTERS.includes(value as PlayFulfillmentFilter)
    ? (value as PlayFulfillmentFilter)
    : 'any';
}

function normalizeAnniversaryMode(value: unknown): PlayAnniversaryMode {
  return ANNIVERSARY_MODES.includes(value as PlayAnniversaryMode)
    ? (value as PlayAnniversaryMode)
    : 'any';
}

function normalizeBenefitSelectionMode(value: unknown): PlayBenefitSelectionMode {
  return BENEFIT_SELECTION_MODES.includes(value as PlayBenefitSelectionMode)
    ? (value as PlayBenefitSelectionMode)
    : 'single';
}

function normalizePurchaseRequirementMode(value: unknown): PlayPurchaseRequirementMode {
  return PURCHASE_REQUIREMENT_MODES.includes(value as PlayPurchaseRequirementMode)
    ? (value as PlayPurchaseRequirementMode)
    : 'none';
}

function normalizeOverlapPolicy(value: unknown): PlayOverlapPolicy {
  return OVERLAP_POLICIES.includes(value as PlayOverlapPolicy)
    ? (value as PlayOverlapPolicy)
    : 'exclusive';
}

function normalizeBenefitStackPolicy(value: unknown): PlayBenefitStackPolicy {
  return BENEFIT_STACK_POLICIES.includes(value as PlayBenefitStackPolicy)
    ? (value as PlayBenefitStackPolicy)
    : 'one_per_order';
}

function normalizeCompatiblePlayIds(value: unknown, currentPlayId: number) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((candidate) => Math.trunc(finiteNumber(candidate, 0)))
      .filter((candidate) => candidate > 0 && candidate !== currentPlayId),
  )).slice(0, 50);
}

async function syncPlayCompatibilities(
  supabase: Awaited<ReturnType<typeof requireMasterOrAdminContext>>['supabase'],
  playId: number,
  overlapPolicy: PlayOverlapPolicy,
  compatiblePlayIds: number[],
  actorUserId: string,
) {
  const { error: clearLowError } = await supabase
    .from('crm_play_compatibilities')
    .delete()
    .eq('play_id_low', playId);
  if (clearLowError) throw new Error(clearLowError.message);

  const { error: clearHighError } = await supabase
    .from('crm_play_compatibilities')
    .delete()
    .eq('play_id_high', playId);
  if (clearHighError) throw new Error(clearHighError.message);

  if (overlapPolicy !== 'selected_compatible' || compatiblePlayIds.length === 0) return;

  const { data: availablePlays, error: availableError } = await supabase
    .from('crm_plays')
    .select('id, overlap_policy')
    .in('id', compatiblePlayIds);
  if (availableError) throw new Error(availableError.message);

  const compatibleIds = (availablePlays ?? [])
    .filter((play) => play.overlap_policy === 'selected_compatible')
    .map((play) => Number(play.id));
  if (compatibleIds.length !== compatiblePlayIds.length) {
    throw new Error('Cada jugada compatible también debe permitir convivencia seleccionada.');
  }

  const { error: insertError } = await supabase
    .from('crm_play_compatibilities')
    .insert(compatibleIds.map((compatiblePlayId) => ({
      play_id_low: Math.min(playId, compatiblePlayId),
      play_id_high: Math.max(playId, compatiblePlayId),
      created_by_user_id: actorUserId,
    })));
  if (insertError) throw new Error(insertError.message);
}

function rulesFromInput(input: SavePlayDraftInput, excludedClientIds: number[]) {
  const minPurchaseCount = Math.max(0, Math.trunc(finiteNumber(input.minPurchaseCount, 1)));
  const maxPurchaseCount = optionalNonNegativeInteger(input.maxPurchaseCount);
  const minNetRevenueUsd = Math.max(0, finiteNumber(input.minNetRevenueUsd, 0));
  const minDaysSincePurchase = optionalNonNegativeInteger(input.minDaysSincePurchase);
  const maxDaysSincePurchase = optionalNonNegativeInteger(input.maxDaysSincePurchase);
  const anniversaryMode = normalizeAnniversaryMode(input.anniversaryMode);
  const anniversaryMonth = input.anniversaryMonth == null || input.anniversaryMonth === 0
    ? null
    : Math.trunc(finiteNumber(input.anniversaryMonth, Number.NaN));

  if (maxPurchaseCount != null && maxPurchaseCount < minPurchaseCount) {
    throw new Error('El máximo de compras no puede ser menor que el mínimo.');
  }
  if (minDaysSincePurchase != null && maxDaysSincePurchase != null && maxDaysSincePurchase < minDaysSincePurchase) {
    throw new Error('El máximo de días no puede ser menor que el mínimo.');
  }
  if (anniversaryMonth != null && (!Number.isFinite(anniversaryMonth) || anniversaryMonth < 1 || anniversaryMonth > 12)) {
    throw new Error('El mes de aniversario debe estar entre 1 y 12.');
  }
  if (anniversaryMode !== 'any' && anniversaryMonth == null) {
    throw new Error('Selecciona el mes que deseas incluir o excluir por aniversario.');
  }

  return {
    play_type: normalizeKind(input.kind),
    min_purchase_count: minPurchaseCount,
    max_purchase_count: maxPurchaseCount,
    min_net_revenue_usd: Number(minNetRevenueUsd.toFixed(2)),
    min_days_since_purchase: minDaysSincePurchase,
    max_days_since_purchase: maxDaysSincePurchase,
    first_purchase_from: dateKey(input.firstPurchaseFrom, 'La compra inicial desde'),
    first_purchase_to: dateKey(input.firstPurchaseTo, 'La compra inicial hasta'),
    last_purchase_from: dateKey(input.lastPurchaseFrom, 'La última compra desde'),
    last_purchase_to: dateKey(input.lastPurchaseTo, 'La última compra hasta'),
    last_gift_from: dateKey(input.lastGiftFrom, 'El último obsequio desde'),
    last_gift_to: dateKey(input.lastGiftTo, 'El último obsequio hasta'),
    include_never_gifted: input.includeNeverGifted !== false,
    anniversary_mode: anniversaryMode,
    anniversary_month: anniversaryMonth,
    fulfillment: normalizeFulfillment(input.fulfillment),
    excluded_client_ids: Array.from(new Set(excludedClientIds.filter((id) => Number.isInteger(id) && id > 0))),
  };
}

function readExcludedClientIds(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>).excluded_client_ids;
  if (!Array.isArray(ids)) return [];
  return ids.map(Number).filter((id) => Number.isInteger(id) && id > 0);
}

function actionError(error: unknown): PlayActionResult {
  return {
    ok: false,
    error: error instanceof Error ? error.message : 'No se pudo completar la acción de la jugada.',
  };
}

async function insertPlayBenefitUpgrades(
  supabase: Awaited<ReturnType<typeof requireMasterOrAdminContext>>['supabase'],
  playId: number,
  benefitOptions: Array<PlayBenefitInput>,
  insertedBenefits: Array<{ id: number | string; product_id: number | string }>,
) {
  const benefitIdByProduct = new Map(
    insertedBenefits.map((row) => [Number(row.product_id), Number(row.id)]),
  );
  const upgrades = benefitOptions.flatMap((option) => option.upgradeProductIds.map((targetProductId, index) => ({
    play_id: playId,
    play_benefit_id: benefitIdByProduct.get(option.productId),
    target_product_id: targetProductId,
    target_quantity: Number(option.quantity.toFixed(3)),
    sort_order: index + 1,
  })));

  if (upgrades.some((upgrade) => !upgrade.play_benefit_id)) {
    throw new Error('No se pudo relacionar una ampliación con su beneficio base.');
  }
  if (upgrades.length === 0) return;

  const { error } = await supabase.from('crm_play_benefit_upgrades').insert(upgrades);
  if (error) throw new Error(error.message);
}

export async function savePlayDraftAction(input: SavePlayDraftInput): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(input.playId, 0));
    const name = cleanText(input.name, 120);
    const description = cleanText(input.description, 1000) || null;
    const advisorGuidance = cleanText(input.advisorGuidance, 4000) || null;
    const messageTemplate = cleanText(input.messageTemplate, 6000) || null;
    const startsOn = dateKey(input.startsOn, 'La fecha inicial', true);
    const endsOn = dateKey(input.endsOn, 'La fecha final', true);
    const plannedBudgetUsd = input.plannedBudgetUsd == null
      ? null
      : finiteNumber(input.plannedBudgetUsd, Number.NaN);
    const benefitSelectionMode = normalizeBenefitSelectionMode(input.benefitSelectionMode);
    const purchaseRequirementMode = normalizePurchaseRequirementMode(input.purchaseRequirementMode);
    const minimumOrderAmountUsd = purchaseRequirementMode === 'minimum_order'
      ? finiteNumber(input.minimumOrderAmountUsd, Number.NaN)
      : null;
    const overlapPolicy = normalizeOverlapPolicy(input.overlapPolicy);
    const compatiblePlayIds = normalizeCompatiblePlayIds(input.compatiblePlayIds, playId);
    const benefitStackPolicy = normalizeBenefitStackPolicy(input.benefitStackPolicy);
    const evaluationWindowDays = Math.trunc(finiteNumber(input.evaluationWindowDays, 90));
    const metricWindow = Math.max(2, Math.min(50, Math.trunc(finiteNumber(input.metricWindow, 6))));
    const benefitOptions = Array.isArray(input.benefits)
      ? input.benefits.slice(0, 8).map((option) => ({
          productId: Math.trunc(finiteNumber(option.productId, 0)),
          quantity: finiteNumber(option.quantity, 0),
          unitBenefitValueUsd: finiteNumber(option.unitBenefitValueUsd, Number.NaN),
          unitAdvisorCostUsd: finiteNumber(option.unitAdvisorCostUsd, Number.NaN),
          unitCompanyCostUsd: finiteNumber(option.unitCompanyCostUsd, Number.NaN),
          upgradeProductIds: Array.from(new Set(
            (Array.isArray(option.upgradeProductIds) ? option.upgradeProductIds : [])
              .slice(0, 8)
              .map((value) => Math.trunc(finiteNumber(value, 0)))
              .filter((value) => value > 0),
          )),
        }))
      : [];

    if (!name) throw new Error('Escribe un nombre para la jugada.');
    if (Date.parse(startBoundary(startsOn)) >= Date.parse(endBoundary(endsOn))) {
      throw new Error('La fecha final debe ser posterior a la fecha inicial.');
    }
    if (benefitOptions.length === 0) {
      throw new Error('Selecciona al menos un beneficio.');
    }
    if (benefitOptions.some((option) => option.productId <= 0 || option.quantity <= 0)) {
      throw new Error('Cada beneficio debe tener un producto y una cantidad válida.');
    }
    if (benefitOptions.some((option) =>
      !Number.isFinite(option.unitBenefitValueUsd) || option.unitBenefitValueUsd < 0
      || !Number.isFinite(option.unitAdvisorCostUsd) || option.unitAdvisorCostUsd < 0
      || !Number.isFinite(option.unitCompanyCostUsd) || option.unitCompanyCostUsd < 0
    )) {
      throw new Error('Cada beneficio debe tener valores válidos para el asesor y la empresa.');
    }
    if (benefitOptions.some((option) =>
      Math.abs(option.unitBenefitValueUsd - option.unitAdvisorCostUsd - option.unitCompanyCostUsd) > 0.011
    )) {
      throw new Error('En cada beneficio, el aporte del asesor más el de la empresa debe ser igual al valor total.');
    }
    if (plannedBudgetUsd != null && (!Number.isFinite(plannedBudgetUsd) || plannedBudgetUsd < 0)) {
      throw new Error('El presupuesto de la jugada no es válido.');
    }
    if (purchaseRequirementMode === 'minimum_order'
      && (!Number.isFinite(minimumOrderAmountUsd) || Number(minimumOrderAmountUsd) <= 0)) {
      throw new Error('Indica una compra mínima mayor que cero o marca la jugada sin condición de compra.');
    }
    if (evaluationWindowDays < 7 || evaluationWindowDays > 365) {
      throw new Error('La ventana de evaluación debe estar entre 7 y 365 días.');
    }
    if (overlapPolicy === 'exclusive' && compatiblePlayIds.length > 0) {
      throw new Error('Una jugada exclusiva no puede seleccionar convivencias.');
    }
    const benefitProductIds = benefitOptions.map((option) => option.productId);
    if (new Set(benefitProductIds).size !== benefitProductIds.length) {
      throw new Error('Un mismo beneficio no puede aparecer dos veces.');
    }

    if (benefitOptions.some((option) => option.upgradeProductIds.includes(option.productId))) {
      throw new Error('El producto base no puede repetirse como ampliación del mismo beneficio.');
    }

    const allProductIds = Array.from(new Set(benefitOptions.flatMap((option) => [
      option.productId,
      ...option.upgradeProductIds,
    ])));
    const { data: products, error: productError } = await ctx.supabase
      .from('products')
      .select('id, is_active, type')
      .in('id', allProductIds)
      .eq('is_active', true)
      .in('type', [...BENEFIT_PRODUCT_TYPES]);
    if (productError) throw new Error(productError.message);
    if ((products ?? []).length !== allProductIds.length) {
      throw new Error('Uno de los beneficios o ampliaciones no está disponible para una jugada.');
    }

    const primaryBenefit = benefitOptions[0];

    let excludedClientIds: number[] = [];
    if (playId > 0) {
      const { data: currentPlay, error: currentPlayError } = await ctx.supabase
        .from('crm_plays')
        .select('id, status, rules_snapshot')
        .eq('id', playId)
        .maybeSingle();
      if (currentPlayError) throw new Error(currentPlayError.message);
      if (!currentPlay) throw new Error('La jugada ya no existe.');
      if (currentPlay.status !== 'draft') throw new Error('La definición ya fue confirmada y no se puede editar.');
      excludedClientIds = readExcludedClientIds(currentPlay.rules_snapshot);
    }

    const rulesSnapshot = rulesFromInput(input, excludedClientIds);
    const payload = {
      name,
      description,
      advisor_guidance: advisorGuidance,
      message_template: messageTemplate,
      rules_snapshot: rulesSnapshot,
      selection_summary: {},
      metric_window: metricWindow,
      gift_product_id: primaryBenefit.productId,
      gift_quantity: Number(primaryBenefit.quantity.toFixed(3)),
      planned_budget_usd: plannedBudgetUsd == null ? null : Number(plannedBudgetUsd.toFixed(2)),
      benefit_selection_mode: benefitSelectionMode,
      purchase_requirement_mode: purchaseRequirementMode,
      minimum_order_amount_usd: minimumOrderAmountUsd == null
        ? null
        : Number(Number(minimumOrderAmountUsd).toFixed(2)),
      overlap_policy: overlapPolicy,
      benefit_stack_policy: benefitStackPolicy,
      evaluation_window_days: evaluationWindowDays,
      starts_at: startBoundary(startsOn),
      ends_at: endBoundary(endsOn),
    };

    if (playId > 0) {
      // Clear the old cut first so a partial request can never leave stale
      // members attached to a newly edited definition.
      const { error: clearError } = await ctx.supabase
        .from('crm_play_members')
        .delete()
        .eq('play_id', playId);
      if (clearError) throw new Error(clearError.message);

      const { error: clearBenefitsError } = await ctx.supabase
        .from('crm_play_benefits')
        .delete()
        .eq('play_id', playId);
      if (clearBenefitsError) throw new Error(clearBenefitsError.message);

      const { error: updateError } = await ctx.supabase
        .from('crm_plays')
        .update(payload)
        .eq('id', playId)
        .eq('status', 'draft');
      if (updateError) throw new Error(updateError.message);

      const { data: insertedBenefits, error: benefitsError } = await ctx.supabase
        .from('crm_play_benefits')
        .insert(benefitOptions.map((option, index) => ({
          play_id: playId,
          product_id: option.productId,
          quantity: Number(option.quantity.toFixed(3)),
          unit_benefit_value_usd: Number(option.unitBenefitValueUsd.toFixed(2)),
          unit_advisor_cost_usd: Number(option.unitAdvisorCostUsd.toFixed(2)),
          unit_company_cost_usd: Number(option.unitCompanyCostUsd.toFixed(2)),
          unit_budget_cost_usd: Number(option.unitCompanyCostUsd.toFixed(2)),
          sort_order: index + 1,
        })))
        .select('id, product_id');
      if (benefitsError) throw new Error(benefitsError.message);
      await insertPlayBenefitUpgrades(ctx.supabase, playId, benefitOptions, insertedBenefits ?? []);

      await syncPlayCompatibilities(ctx.supabase, playId, overlapPolicy, compatiblePlayIds, ctx.user.id);

      revalidatePath('/app/master/plays');
      return { ok: true, playId, message: 'Definición actualizada. Genera nuevamente la lista.' };
    }

    const seriesKey = normalizeKind(input.kind);
    const { data: latestVersion, error: versionError } = await ctx.supabase
      .from('crm_plays')
      .select('version')
      .eq('series_key', seriesKey)
      .order('version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (versionError) throw new Error(versionError.message);

    const { data: created, error: createError } = await ctx.supabase
      .from('crm_plays')
      .insert({
        ...payload,
        series_key: seriesKey,
        version: Math.max(1, Math.trunc(finiteNumber(latestVersion?.version, 0)) + 1),
        status: 'draft',
        created_by_user_id: ctx.user.id,
      })
      .select('id')
      .single();
    if (createError) throw new Error(createError.message);

    const createdId = Number(created.id);
    const { data: insertedBenefits, error: benefitsError } = await ctx.supabase
      .from('crm_play_benefits')
      .insert(benefitOptions.map((option, index) => ({
        play_id: createdId,
        product_id: option.productId,
        quantity: Number(option.quantity.toFixed(3)),
        unit_benefit_value_usd: Number(option.unitBenefitValueUsd.toFixed(2)),
        unit_advisor_cost_usd: Number(option.unitAdvisorCostUsd.toFixed(2)),
        unit_company_cost_usd: Number(option.unitCompanyCostUsd.toFixed(2)),
        unit_budget_cost_usd: Number(option.unitCompanyCostUsd.toFixed(2)),
        sort_order: index + 1,
      })))
      .select('id, product_id');
    if (benefitsError) throw new Error(benefitsError.message);
    await insertPlayBenefitUpgrades(ctx.supabase, createdId, benefitOptions, insertedBenefits ?? []);

    await syncPlayCompatibilities(ctx.supabase, createdId, overlapPolicy, compatiblePlayIds, ctx.user.id);

    revalidatePath('/app/master/plays');
    return { ok: true, playId: createdId, message: 'Jugada guardada en diseño. Todavía no es visible para los asesores.' };
  } catch (error) {
    return actionError(error);
  }
}

async function refreshPlayPreviewSummary(
  supabase: Awaited<ReturnType<typeof requireMasterOrAdminContext>>['supabase'],
  playId: number,
) {
  const { data, error } = await supabase.rpc('crm_refresh_play_preview_summary_v1', {
    p_play_id: playId,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function generatePlayListAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const { error } = await ctx.supabase.rpc('crm_prepare_play_preview_v2', {
      p_play_id: playId,
    });
    if (error) throw new Error(error.message);

    const { data: playSummary, error: summaryError } = await ctx.supabase
      .from('crm_plays')
      .select('selection_summary')
      .eq('id', playId)
      .single();
    if (summaryError) throw new Error(summaryError.message);
    const data = playSummary.selection_summary;

    const total = data && typeof data === 'object' && !Array.isArray(data)
      ? Math.max(0, Math.trunc(finiteNumber((data as Record<string, unknown>).total, 0)))
      : 0;
    revalidatePath('/app/master/plays');
    return { ok: true, playId, message: `Prueba generada con ${total.toLocaleString('es-VE')} candidatos.` };
  } catch (error) {
    return actionError(error);
  }
}

export async function testPlayDefinitionAction(input: SavePlayDraftInput): Promise<PlayActionResult> {
  const saved = await savePlayDraftAction(input);
  if (!saved.ok || !saved.playId) return saved;

  const generated = await generatePlayListAction(saved.playId);
  if (!generated.ok) return generated;
  return {
    ...generated,
    message: generated.message || 'La definición fue probada. Revisa los candidatos antes de confirmar.',
  };
}

export async function excludePlayClientAction(playIdInput: number, clientIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    const clientId = Math.trunc(finiteNumber(clientIdInput, 0));
    if (playId <= 0 || clientId <= 0) throw new Error('La jugada o el cliente no son válidos.');

    const { error } = await ctx.supabase.rpc('crm_exclude_play_client_v1', {
      p_play_id: playId,
      p_client_id: clientId,
    });
    if (error) throw new Error(error.message);

    await refreshPlayPreviewSummary(ctx.supabase, playId);

    revalidatePath('/app/master/plays');
    return { ok: true, playId, message: 'Cliente retirado. No volverá al regenerar esta lista.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function amendPublishedPlayMessageAction(
  input: AmendPublishedPlayMessageInput,
): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(input.playId, 0));
    const reason = cleanText(input.reason, 500);
    if (playId <= 0) throw new Error('La jugada no es válida.');
    if (reason.length < 3) throw new Error('Explica brevemente el motivo del cambio.');

    const { error } = await ctx.supabase.rpc('crm_amend_play_message_v1', {
      p_play_id: playId,
      p_message_template: cleanText(input.messageTemplate, 6000) || null,
      p_advisor_guidance: cleanText(input.advisorGuidance, 4000) || null,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return { ok: true, playId, message: 'Mensaje actualizado. La versión anterior quedó registrada.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function addManualPlayMemberAction(
  input: AddManualPlayMemberInput,
): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(input.playId, 0));
    const clientId = Math.trunc(finiteNumber(input.clientId, 0));
    const advisorId = cleanText(input.advisorId, 80);
    const reason = cleanText(input.reason, 500);
    if (playId <= 0 || clientId <= 0) throw new Error('La jugada o el cliente no son válidos.');
    if (!advisorId) throw new Error('Selecciona el asesor que recibirá al cliente.');
    if (reason.length < 3) throw new Error('Explica brevemente por qué deseas incluirlo.');

    const { data, error } = await ctx.supabase.rpc('crm_add_manual_play_member_v1', {
      p_play_id: playId,
      p_client_id: clientId,
      p_advisor_id: advisorId,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return {
      ok: true,
      playId,
      message: result.restored
        ? 'Cliente reincorporado y asignado. El cambio quedó registrado.'
        : 'Cliente incluido manualmente. Ya forma parte de la lista y quedó registrado.',
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function removePublishedPlayClientAction(
  playIdInput: number,
  clientIdInput: number,
  reasonInput: string,
): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    const clientId = Math.trunc(finiteNumber(clientIdInput, 0));
    const reason = cleanText(reasonInput, 500);
    if (playId <= 0 || clientId <= 0) throw new Error('La jugada o el cliente no son válidos.');
    if (reason.length < 3) throw new Error('Explica brevemente por qué deseas retirarlo.');

    const { error } = await ctx.supabase.rpc('crm_remove_published_play_member_v1', {
      p_play_id: playId,
      p_client_id: clientId,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return { ok: true, playId, message: 'Cliente retirado. Conservamos sus contactos previos y la razón del cambio.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function excludePublishedPlayAdvisorAction(
  playIdInput: number,
  advisorIdInput: string,
  reasonInput: string,
): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    const advisorId = cleanText(advisorIdInput, 80);
    const reason = cleanText(reasonInput, 500);
    if (playId <= 0 || !advisorId) throw new Error('La jugada o el asesor no son válidos.');
    if (reason.length < 3) throw new Error('Explica brevemente por qué deseas retirar al asesor.');

    const { data, error } = await ctx.supabase.rpc('crm_exclude_play_advisor_v1', {
      p_play_id: playId,
      p_advisor_id: advisorId,
      p_reason: reason,
    });
    if (error) throw new Error(error.message);
    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
    const removedCount = Math.max(0, Math.trunc(finiteNumber(result.removed_client_count, 0)));
    const preservedCount = Math.max(0, Math.trunc(finiteNumber(result.preserved_redeemed_client_count, 0)));

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return {
      ok: true,
      playId,
      message: `${removedCount.toLocaleString('es-VE')} clientes retirados del asesor.${preservedCount > 0 ? ` ${preservedCount.toLocaleString('es-VE')} se conservaron porque ya usaron el beneficio.` : ''}`,
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function confirmPlayListAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const { data, error } = await ctx.supabase.rpc('crm_confirm_play_v1', {
      p_play_id: playId,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('La jugada ya no está disponible para confirmar.');

    revalidatePath('/app/master/plays');
    return { ok: true, playId, message: 'Lista confirmada. Aún no ha sido compartida con los asesores.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function clonePlayAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const { data, error } = await ctx.supabase.rpc('crm_clone_play_v2', {
      p_source_play_id: playId,
      p_name: null,
    });
    if (error) throw new Error(error.message);

    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
    const clonedPlayId = Math.trunc(finiteNumber(result.play_id, 0));
    if (clonedPlayId <= 0) throw new Error('No se pudo identificar la copia creada.');

    revalidatePath('/app/master/plays');
    return {
      ok: true,
      playId: clonedPlayId,
      message: 'Copia creada en diseño. Ajusta fechas, reglas y mensaje antes de probarla.',
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function clonePlayForNextPeriodAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const { data, error } = await ctx.supabase.rpc('crm_clone_play_v3', {
      p_source_play_id: playId,
      p_name: null,
      p_shift_months: 1,
    });
    if (error) throw new Error(error.message);

    const result = data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {};
    const clonedPlayId = Math.trunc(finiteNumber(result.play_id, 0));
    if (clonedPlayId <= 0) throw new Error('No se pudo identificar el siguiente período creado.');

    revalidatePath('/app/master/plays');
    return {
      ok: true,
      playId: clonedPlayId,
      message: 'Siguiente período preparado en diseño. Conserva la definición, pero generará una lista nueva.',
    };
  } catch (error) {
    return actionError(error);
  }
}

export async function activatePlayAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const activatedAt = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from('crm_plays')
      .update({
        status: 'active',
        activated_at: activatedAt,
        activated_by_user_id: ctx.user.id,
      })
      .eq('id', playId)
      .eq('status', 'frozen')
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Primero confirma la lista que deseas compartir.');

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return { ok: true, playId, message: 'Jugada compartida. Cada asesor ya puede ver únicamente sus clientes.' };
  } catch (error) {
    return actionError(error);
  }
}

export async function changePlayLifecycleAction(
  playIdInput: number,
  command: PlayLifecycleCommand,
): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const transitions: Record<PlayLifecycleCommand, { message: string }> = {
      pause: {
        message: 'Jugada pausada. Los asesores conservan la lista, pero no pueden aplicar beneficios.',
      },
      resume: {
        message: 'Jugada reactivada para los asesores.',
      },
      close: {
        message: 'Jugada cerrada. El snapshot queda disponible para evaluación histórica.',
      },
    };
    const transition = transitions[command];
    if (!transition) throw new Error('La acción solicitada no es válida.');

    const { data, error } = await ctx.supabase.rpc('crm_change_play_lifecycle_v1', {
      p_play_id: playId,
      p_command: command,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error('La jugada cambió de estado. Actualiza la pantalla e inténtalo nuevamente.');

    revalidatePath('/app/master/plays');
    revalidatePath('/app/advisor/plays');
    return { ok: true, playId, message: transition.message };
  } catch (error) {
    return actionError(error);
  }
}

export async function deleteDraftPlayAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const { error } = await ctx.supabase.rpc('crm_delete_draft_play_v1', {
      p_play_id: playId,
    });
    if (error) throw new Error(error.message);

    revalidatePath('/app/master/plays');
    return { ok: true, playId, message: 'La prueba fue eliminada por completo.' };
  } catch (error) {
    return actionError(error);
  }
}
