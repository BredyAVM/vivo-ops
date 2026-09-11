import AdvisorOrderComposer, { type ClientRow } from './AdvisorOrderComposer';
import { getAuthContext } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { readEventBudgetPayload } from '@/lib/events/event-budget';
import { loadAdvisorCrmOrderContext } from '@/lib/crm/advisor-order-context';
import type { AdvisorCrmOrderContext } from '@/lib/crm/advisor-order-context-types';

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
  let initialClient: ClientRow | null = null;
  let initialCrmContext: AdvisorCrmOrderContext | null = null;

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
    && !fromOrder && !duplicateFrom && !initialDraft
  ) {
    const ctx = await getAuthContext();
    if (ctx) {
      try {
        initialCrmContext = await loadAdvisorCrmOrderContext({
          supabase: ctx.supabase,
          advisorUserId: ctx.user.id,
          clientId: requestedClientId,
          playMemberId: Number.isFinite(requestedPlayMemberId) && requestedPlayMemberId > 0
            ? requestedPlayMemberId
            : null,
        });
      } catch (error) {
        console.warn(
          'No se pudo precargar la jugada del cliente.',
          error instanceof Error ? error.message : error,
        );
      }
      if (initialCrmContext) initialClient = initialCrmContext.client as ClientRow;

      if (!initialClient) {
        const { data: client } = await ctx.supabase
          .from('clients')
          .select(`
            id, full_name, phone, client_type, fund_balance_usd, recent_addresses,
            billing_company_name, billing_tax_id, billing_address, billing_phone,
            delivery_note_name, delivery_note_document_id, delivery_note_address, delivery_note_phone
          `)
          .eq('id', requestedClientId)
          .maybeSingle();
        if (client) initialClient = client as ClientRow;
      }
    }
  }

  return (
    <AdvisorOrderComposer
      existingOrderId={Number.isFinite(fromOrder) && fromOrder > 0 ? fromOrder : null}
      templateOrderId={Number.isFinite(duplicateFrom) && duplicateFrom > 0 ? duplicateFrom : null}
      initialDraft={initialDraft}
      initialClient={initialClient}
      initialCrmContext={initialCrmContext}
    />
  );
}
