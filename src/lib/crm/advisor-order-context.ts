import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { isPlayOrderAvailableAt } from '@/lib/crm/play-order';
import type { AdvisorCrmOrderContext, MasterCrmOrderContext } from '@/lib/crm/advisor-order-context-types';

type LoadAdvisorCrmOrderContextInput = {
  supabase: SupabaseClient;
  advisorUserId: string;
  clientId: number;
  playMemberId?: number | null;
};

type RelatedRow = Record<string, unknown> | Array<Record<string, unknown>> | null;

function firstRelated(value: RelatedRow) {
  return Array.isArray(value) ? value[0] ?? null : value;
}
export async function loadAdvisorCrmOrderContext(input: LoadAdvisorCrmOrderContextInput): Promise<AdvisorCrmOrderContext | null> {
  return loadCrmOrderContext(input);
}

// The caller must authorize master/admin access before requesting an unscoped member.
export async function loadMasterCrmOrderContext(input: Omit<LoadAdvisorCrmOrderContextInput, 'advisorUserId'>): Promise<MasterCrmOrderContext | null> {
  return loadCrmOrderContext(input);
}

async function loadCrmOrderContext({
  supabase,
  advisorUserId,
  clientId,
  playMemberId = null,
}: Omit<LoadAdvisorCrmOrderContextInput, 'advisorUserId'> & { advisorUserId?: string }): Promise<MasterCrmOrderContext | null> {
  let memberQuery = supabase
    .from('crm_play_members')
    .select(`
      id, client_id, advisor_id_snapshot, workflow_status, benefit_status,
      client:clients!crm_play_members_client_id_fkey(
        id, full_name, phone, client_type, fund_balance_usd, recent_addresses,
        billing_company_name, billing_tax_id, billing_address, billing_phone,
        delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone
      ),
      play:crm_plays!crm_play_members_play_id_fkey(
        id, name, status, starts_at, ends_at, benefit_selection_mode,
        purchase_requirement_mode, minimum_order_amount_usd
      )
    `)
    .eq('client_id', clientId)
    .eq('benefit_status', 'available')
    .neq('workflow_status', 'removed')
    .order('id', { ascending: false });

  if (advisorUserId !== undefined) memberQuery = memberQuery.eq('advisor_id_snapshot', advisorUserId);

  if (playMemberId && Number.isFinite(playMemberId) && playMemberId > 0) {
    memberQuery = memberQuery.eq('id', Math.trunc(playMemberId));
  }

  const { data: memberRows, error: memberError } = await memberQuery.limit(20);
  if (memberError) throw new Error(memberError.message);

  const activeMember = (memberRows ?? []).find((candidate) => {
    const play = firstRelated(candidate.play as RelatedRow);
    return Boolean(play) && isPlayOrderAvailableAt({
      status: String(play?.status ?? ''),
      startsAt: play?.starts_at == null ? null : String(play.starts_at),
      endsAt: play?.ends_at == null ? null : String(play.ends_at),
      now: new Date(),
    });
  });
  if (!activeMember) return null;

  const play = firstRelated(activeMember.play as RelatedRow);
  const client = firstRelated(activeMember.client as RelatedRow);
  const activePlayId = Number(play?.id ?? 0);
  const activeMemberId = Number(activeMember.id ?? 0);
  if (!play || !client || activePlayId <= 0 || activeMemberId <= 0) return null;

  const [{ data: optionRows, error: optionError }, { data: selectionRows, error: selectionError }] = await Promise.all([
    supabase
      .from('crm_play_benefits')
      .select(`
        id, product_id, quantity, unit_benefit_value_usd, sort_order,
        product:products!crm_play_benefits_product_id_fkey(name, sku)
      `)
      .eq('play_id', activePlayId)
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('crm_play_member_benefit_selections')
      .select('play_benefit_id')
      .eq('play_member_id', activeMemberId)
      .order('selected_at', { ascending: true }),
  ]);
  if (optionError) throw new Error(optionError.message);
  if (selectionError) throw new Error(selectionError.message);

  const optionIds = (optionRows ?? []).map((option) => Number(option.id)).filter((id) => id > 0);
  if (optionIds.length === 0) return null;

  const { data: upgradeRows, error: upgradeError } = await supabase
    .from('crm_play_benefit_upgrades')
    .select(`
      id, play_benefit_id, target_product_id, target_quantity,
      customer_difference_usd_snapshot, sort_order,
      product:products!crm_play_benefit_upgrades_target_product_id_fkey(name, sku)
    `)
    .in('play_benefit_id', optionIds)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (upgradeError) throw new Error(upgradeError.message);

  const upgradesByBenefit = new Map<number, AdvisorCrmOrderContext['benefits'][number]['upgrades']>();
  for (const row of upgradeRows ?? []) {
    const product = firstRelated(row.product as RelatedRow);
    const benefitId = Number(row.play_benefit_id);
    const upgrades = upgradesByBenefit.get(benefitId) ?? [];
    upgrades.push({
      id: Number(row.id),
      productId: Number(row.target_product_id),
      quantity: Number(row.target_quantity),
      customerDifferenceUsd: Number(row.customer_difference_usd_snapshot ?? 0),
      name: product?.name ? String(product.name) : 'Ampliación',
      sku: product?.sku == null ? null : String(product.sku),
    });
    upgradesByBenefit.set(benefitId, upgrades);
  }

  const benefits = (optionRows ?? []).flatMap((option) => {
    const product = firstRelated(option.product as RelatedRow);
    const optionId = Number(option.id);
    const quantity = Number(option.quantity);
    if (optionId <= 0 || Number(option.product_id) <= 0 || quantity <= 0) return [];
    return [{
      playBenefitId: optionId,
      productId: Number(option.product_id),
      quantity,
      creditUsd: Number(option.unit_benefit_value_usd ?? 0) * quantity,
      name: product?.name ? String(product.name) : 'Beneficio',
      sku: product?.sku == null ? null : String(product.sku),
      upgrades: upgradesByBenefit.get(optionId) ?? [],
    }];
  });
  if (benefits.length === 0) return null;

  const availableBenefitIds = new Set(benefits.map((benefit) => benefit.playBenefitId));
  const selectedPlayBenefitIds = (selectionRows ?? [])
    .map((selection) => Number(selection.play_benefit_id))
    .filter((benefitId) => availableBenefitIds.has(benefitId));

  return {
    advisorUserId: activeMember.advisor_id_snapshot == null ? null : String(activeMember.advisor_id_snapshot),
    playMemberId: activeMemberId,
    playName: String(play.name || 'Jugada activa'),
    benefitSelectionMode: String(play.benefit_selection_mode) === 'multiple' ? 'multiple' : 'single',
    selectedPlayBenefitIds,
    purchaseRequirementMode: String(play.purchase_requirement_mode) === 'minimum_order'
      ? 'minimum_order'
      : 'none',
    minimumOrderAmountUsd: play.minimum_order_amount_usd == null
      ? null
      : Number(play.minimum_order_amount_usd),
    client: client as AdvisorCrmOrderContext['client'],
    benefits,
  };
}
