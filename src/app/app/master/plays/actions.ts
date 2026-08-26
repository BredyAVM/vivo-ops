'use server';

import { revalidatePath } from 'next/cache';
import { requireMasterOrAdminContext } from '@/lib/auth';

const PLAY_KINDS = ['anniversary', 'loyalty', 'new_client', 'reconnect', 'seasonal', 'custom'] as const;
const FULFILLMENT_FILTERS = ['any', 'pickup', 'delivery'] as const;
const ANNIVERSARY_MODES = ['any', 'include', 'exclude'] as const;
const BENEFIT_PRODUCT_TYPES = ['product', 'combo', 'promo', 'gambit'] as const;

export type PlayKind = (typeof PLAY_KINDS)[number];
export type PlayFulfillmentFilter = (typeof FULFILLMENT_FILTERS)[number];
export type PlayAnniversaryMode = (typeof ANNIVERSARY_MODES)[number];

export type PlayBenefitInput = {
  productId: number;
  quantity: number;
  unitBudgetCostUsd: number;
};

export type SavePlayDraftInput = {
  playId?: number | null;
  name: string;
  description?: string;
  kind: PlayKind;
  startsOn: string;
  endsOn: string;
  plannedBudgetUsd?: number | null;
  benefits: PlayBenefitInput[];
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

export async function savePlayDraftAction(input: SavePlayDraftInput): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(input.playId, 0));
    const name = cleanText(input.name, 120);
    const description = cleanText(input.description, 1000) || null;
    const startsOn = dateKey(input.startsOn, 'La fecha inicial', true);
    const endsOn = dateKey(input.endsOn, 'La fecha final', true);
    const plannedBudgetUsd = input.plannedBudgetUsd == null
      ? null
      : finiteNumber(input.plannedBudgetUsd, Number.NaN);
    const metricWindow = Math.max(2, Math.min(50, Math.trunc(finiteNumber(input.metricWindow, 6))));
    const benefitOptions = Array.isArray(input.benefits)
      ? input.benefits.slice(0, 8).map((option) => ({
          productId: Math.trunc(finiteNumber(option.productId, 0)),
          quantity: finiteNumber(option.quantity, 0),
          unitBudgetCostUsd: finiteNumber(option.unitBudgetCostUsd, Number.NaN),
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
    if (benefitOptions.some((option) => !Number.isFinite(option.unitBudgetCostUsd) || option.unitBudgetCostUsd < 0)) {
      throw new Error('Cada beneficio debe tener un costo presupuestario válido.');
    }
    if (plannedBudgetUsd != null && (!Number.isFinite(plannedBudgetUsd) || plannedBudgetUsd < 0)) {
      throw new Error('El presupuesto de la jugada no es válido.');
    }
    const benefitProductIds = benefitOptions.map((option) => option.productId);
    if (new Set(benefitProductIds).size !== benefitProductIds.length) {
      throw new Error('Un mismo beneficio no puede aparecer dos veces.');
    }

    const { data: products, error: productError } = await ctx.supabase
      .from('products')
      .select('id, is_active, type')
      .in('id', benefitProductIds)
      .eq('is_active', true)
      .in('type', [...BENEFIT_PRODUCT_TYPES]);
    if (productError) throw new Error(productError.message);
    if ((products ?? []).length !== benefitProductIds.length) {
      throw new Error('Uno de los beneficios seleccionados no está disponible para una jugada.');
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
      rules_snapshot: rulesSnapshot,
      selection_summary: {},
      metric_window: metricWindow,
      gift_product_id: primaryBenefit.productId,
      gift_quantity: Number(primaryBenefit.quantity.toFixed(3)),
      planned_budget_usd: plannedBudgetUsd == null ? null : Number(plannedBudgetUsd.toFixed(2)),
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

      const { error: benefitsError } = await ctx.supabase
        .from('crm_play_benefits')
        .insert(benefitOptions.map((option, index) => ({
          play_id: playId,
          product_id: option.productId,
          quantity: Number(option.quantity.toFixed(3)),
          unit_budget_cost_usd: Number(option.unitBudgetCostUsd.toFixed(2)),
          sort_order: index + 1,
        })));
      if (benefitsError) throw new Error(benefitsError.message);

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
    const { error: benefitsError } = await ctx.supabase
      .from('crm_play_benefits')
      .insert(benefitOptions.map((option, index) => ({
        play_id: createdId,
        product_id: option.productId,
        quantity: Number(option.quantity.toFixed(3)),
        unit_budget_cost_usd: Number(option.unitBudgetCostUsd.toFixed(2)),
        sort_order: index + 1,
      })));
    if (benefitsError) throw new Error(benefitsError.message);

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

    const { error } = await ctx.supabase.rpc('crm_rebuild_play_members_v1', {
      p_play_id: playId,
    });
    if (error) throw new Error(error.message);

    const data = await refreshPlayPreviewSummary(ctx.supabase, playId);

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

export async function confirmPlayListAction(playIdInput: number): Promise<PlayActionResult> {
  try {
    const ctx = await requireMasterOrAdminContext();
    const playId = Math.trunc(finiteNumber(playIdInput, 0));
    if (playId <= 0) throw new Error('La jugada no es válida.');

    const [membersResult, benefitsResult] = await Promise.all([
      ctx.supabase
        .from('crm_play_members')
        .select('id', { count: 'exact', head: true })
        .eq('play_id', playId),
      ctx.supabase
        .from('crm_play_benefits')
        .select('id', { count: 'exact', head: true })
        .eq('play_id', playId),
    ]);
    if (membersResult.error) throw new Error(membersResult.error.message);
    if (benefitsResult.error) throw new Error(benefitsResult.error.message);
    if (!membersResult.count) throw new Error('Genera y revisa una lista antes de confirmarla.');
    if (!benefitsResult.count) throw new Error('Selecciona al menos un beneficio antes de confirmar.');

    const snapshotAt = new Date().toISOString();
    const { data, error } = await ctx.supabase
      .from('crm_plays')
      .update({ status: 'frozen', snapshot_at: snapshotAt })
      .eq('id', playId)
      .eq('status', 'draft')
      .select('id')
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('La jugada ya no está disponible para confirmar.');

    revalidatePath('/app/master/plays');
    return { ok: true, playId, message: 'Lista confirmada. Aún no ha sido compartida con los asesores.' };
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
