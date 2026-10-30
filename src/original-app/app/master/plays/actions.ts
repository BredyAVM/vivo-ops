'use server';

import { revalidatePath } from 'next/cache';
import { requireAdminContext, requireMasterOrAdminContext } from '@/lib/auth';
import { allowsCrmCatalogProduct } from '@/lib/crm/play-order';
import { offerRestRules, type OfferRestInput } from '@/lib/crm/offer-rest';
import { purchasedProductRules, type PurchasedProductInput } from '@/lib/crm/purchased-products';

const PLAY_KINDS = ['anniversary', 'loyalty', 'new_client', 'reconnect', 'seasonal', 'custom'] as const;

export async function reviewPlayNoApplyAction(requestId: number, approve: boolean, reviewNote: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
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

export type SavePlayDraftInput = OfferRestInput & PurchasedProductInput & {
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
  recurrenceMode?: 'once' | 'daily';
  benefitFulfillment?: 'any' | 'pickup' | 'delivery_zone_1';
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
  includedAdvisorIds: string[];
};

export type PlayActionResult = {
  ok: boolean;
  playId?: number;
  message?: string;
  error?: string;
  revision?: PlayAudiencePreview;
};

export type PlayAudiencePreview = {
  token: string;
  added: number;
  removed: number;
  protected: number;
  total: number;
  clients: Array<{ client_id: number; name: string; advisor: string | null; action: 'add' | 'remove' | 'keep' | 'protected' }>;
};

export async function reopenPlayDesignAction(playId: number, reason: string): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function revisePlayAudienceAction(
  input: SavePlayDraftInput, token?: string, reason?: string,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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

function normalizeAdvisorIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((candidate) => cleanText(candidate, 36).toLowerCase())
      .filter((candidate) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(candidate)),
  )).slice(0, 200);
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
    ...offerRestRules(input),
    ...purchasedProductRules(input),
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
    included_advisor_ids: normalizeAdvisorIds(input.includedAdvisorIds),
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

export async function savePlayDraftAction(input: SavePlayDraftInput): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

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

export async function generatePlayListAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function testPlayDefinitionAction(input: SavePlayDraftInput): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function excludePlayClientAction(playIdInput: number, clientIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function amendPublishedPlayMessageAction(
  input: AmendPublishedPlayMessageInput,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function addManualPlayMemberAction(
  input: AddManualPlayMemberInput,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function removePublishedPlayClientAction(
  playIdInput: number,
  clientIdInput: number,
  reasonInput: string,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function excludePublishedPlayAdvisorAction(
  playIdInput: number,
  advisorIdInput: string,
  reasonInput: string,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function confirmPlayListAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function clonePlayAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function clonePlayForNextPeriodAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function activatePlayAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function changePlayLifecycleAction(
  playIdInput: number,
  command: PlayLifecycleCommand,
): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function deleteDraftPlayAction(playIdInput: number): Promise<PlayActionResult> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
