import AdvisorOrderComposer from './AdvisorOrderComposer';
import { getAuthContext } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { readEventBudgetPayload } from '@/lib/events/event-budget';

type SearchParams = Promise<{
  fromOrder?: string;
  duplicateFrom?: string;
  draftId?: string;
  client?: string;
  playMember?: string;
}>;

export default async function AdvisorNewOrderPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const fromOrder = Number(params.fromOrder || 0);
  const duplicateFrom = Number(params.duplicateFrom || 0);
  const draftId = Number(params.draftId || 0);
  const requestedClientId = Number(params.client || 0);
  const requestedPlayMemberId = Number(params.playMember || 0);
  let initialDraft = null;
  let initialCrmContext = null;

  if (Number.isFinite(draftId) && draftId > 0 && !fromOrder && !duplicateFrom) {
    const ctx = await getAuthContext();
    if (ctx) {
      const { data } = await ctx.supabase
        .from('advisor_order_drafts')
        .select(
          'id, status, title, client_id, client_snapshot, new_client_snapshot, payload, quote_text, total_usd, total_bs, fx_rate, quoted_at, updated_at'
        )
        .eq('id', draftId)
        .eq('advisor_user_id', ctx.user.id)
        .in('status', ['draft', 'quoted'])
        .maybeSingle();

      if (data && readEventBudgetPayload(data.payload)) {
        redirect(`/app/advisor/drafts/${draftId}`);
      }
      initialDraft = data;
    }
  }

  if (
    Number.isFinite(requestedClientId) && requestedClientId > 0
    && Number.isFinite(requestedPlayMemberId) && requestedPlayMemberId > 0
    && !fromOrder && !duplicateFrom && !initialDraft
  ) {
    const ctx = await getAuthContext();
    if (ctx) {
      const { data: member } = await ctx.supabase
        .from('crm_play_members')
        .select(`
          id, client_id, advisor_id_snapshot, benefit_status,
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
        .eq('id', requestedPlayMemberId)
        .eq('client_id', requestedClientId)
        .eq('advisor_id_snapshot', ctx.user.id)
        .maybeSingle();

      const play = Array.isArray(member?.play) ? member.play[0] ?? null : member?.play ?? null;
      const client = Array.isArray(member?.client) ? member.client[0] ?? null : member?.client ?? null;
      if (member && play?.status === 'active' && client && ['available', 'reserved'].includes(String(member.benefit_status))) {
        const { data: selections } = await ctx.supabase
          .from('crm_play_member_benefit_selections')
          .select(`
            play_benefit_id,
            benefit:crm_play_benefits!crm_member_benefit_selection_benefit_fkey(
              id, product_id, quantity,
              product:products!crm_play_benefits_product_id_fkey(name, sku)
            )
          `)
          .eq('play_member_id', requestedPlayMemberId)
          .order('selected_at', { ascending: true });

        const benefits = (selections ?? []).flatMap((selection) => {
          const benefit = Array.isArray(selection.benefit) ? selection.benefit[0] ?? null : selection.benefit ?? null;
          if (!benefit) return [];
          const product = Array.isArray(benefit.product) ? benefit.product[0] ?? null : benefit.product ?? null;
          return [{
            playBenefitId: Number(benefit.id),
            productId: Number(benefit.product_id),
            quantity: Number(benefit.quantity),
            name: product?.name ? String(product.name) : 'Beneficio',
            sku: product?.sku == null ? null : String(product.sku),
          }];
        });

        if (benefits.length > 0) {
          initialCrmContext = {
            playMemberId: Number(member.id),
            playName: String(play.name),
            purchaseRequirementMode: String(play.purchase_requirement_mode) as 'none' | 'minimum_order',
            minimumOrderAmountUsd: play.minimum_order_amount_usd == null ? null : Number(play.minimum_order_amount_usd),
            client,
            benefits,
          };
        }
      }
    }
  }

  return (
    <AdvisorOrderComposer
      existingOrderId={Number.isFinite(fromOrder) && fromOrder > 0 ? fromOrder : null}
      templateOrderId={Number.isFinite(duplicateFrom) && duplicateFrom > 0 ? duplicateFrom : null}
      initialDraft={initialDraft}
      initialCrmContext={initialCrmContext}
    />
  );
}
