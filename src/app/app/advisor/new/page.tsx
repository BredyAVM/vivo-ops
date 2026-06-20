import AdvisorOrderComposer from './AdvisorOrderComposer';
import { getAuthContext } from '@/lib/auth';

type SearchParams = Promise<{
  fromOrder?: string;
  duplicateFrom?: string;
  draftId?: string;
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
  let initialDraft = null;

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

      initialDraft = data;
    }
  }

  return (
    <AdvisorOrderComposer
      existingOrderId={Number.isFinite(fromOrder) && fromOrder > 0 ? fromOrder : null}
      templateOrderId={Number.isFinite(duplicateFrom) && duplicateFrom > 0 ? duplicateFrom : null}
      initialDraft={initialDraft}
    />
  );
}
