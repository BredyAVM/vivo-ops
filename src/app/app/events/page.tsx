import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { readEventBudgetPayload } from '@/lib/events/event-budget';
import EventBudgetsClient from './EventBudgetsClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = '') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function number(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function caracasDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export default async function EventBudgetsPage() {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');
  if (!ctx.roles.includes('admin')) redirect(resolveHomePath(ctx.roles));

  const [productsResult, advisorsResult, rateResult, draftsResult] = await Promise.all([
    ctx.supabase
      .from('products')
      .select('id, sku, name, type, is_active, extra_fields')
      .eq('is_active', true)
      .order('name', { ascending: true })
      .limit(800),
    ctx.supabase.rpc('get_advisor_profiles'),
    ctx.supabase
      .from('exchange_rates')
      .select('rate_bs_per_usd')
      .eq('is_active', true)
      .order('effective_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    ctx.supabase
      .from('advisor_order_drafts')
      .select('id, advisor_user_id, status, title, client_id, client_snapshot, new_client_snapshot, payload, quote_text, total_usd, total_bs, fx_rate, quoted_at, converted_order_id, converted_at, created_at, updated_at')
      .order('updated_at', { ascending: false })
      .limit(250),
  ]);

  const error = productsResult.error ?? advisorsResult.error ?? rateResult.error ?? draftsResult.error;
  if (error) throw new Error(error.message);

  const advisors = ((advisorsResult.data ?? []) as Array<{
    user_id: string | null;
    full_name: string | null;
    is_active: boolean | null;
  }>)
    .filter((advisor) => advisor.is_active !== false && advisor.user_id)
    .map((advisor) => ({
      id: String(advisor.user_id),
      name: text(advisor.full_name, 'Asesor'),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'es-VE'));
  const advisorNameById = new Map(advisors.map((advisor) => [advisor.id, advisor.name]));

  const products = ((productsResult.data ?? []) as Array<{
    id: number | string;
    sku: string | null;
    name: string | null;
    type: string | null;
    extra_fields: Record<string, unknown> | null;
  }>)
    .filter((product) => {
      const extra = object(product.extra_fields);
      return extra.inventory_component_only !== true && extra.catalog_access_scope !== 'admin_internal';
    })
    .map((product) => ({
      id: Number(product.id),
      sku: product.sku,
      name: text(product.name, `Producto #${product.id}`),
      type: text(product.type, 'product'),
    }))
    .filter((product) => product.id > 0);

  const drafts = (draftsResult.data ?? []).flatMap((draft) => {
    const budget = readEventBudgetPayload(draft.payload);
    if (!budget) return [];
    const clientSnapshot = object(draft.client_snapshot);
    const newClientSnapshot = object(draft.new_client_snapshot);
    return [{
      id: Number(draft.id),
      advisorUserId: String(draft.advisor_user_id || ''),
      advisorName: advisorNameById.get(String(draft.advisor_user_id || '')) || 'Asesor',
      status: String(draft.status || 'draft'),
      title: text(draft.title, budget.title),
      clientId: number(draft.client_id) > 0 ? number(draft.client_id) : null,
      clientName: text(clientSnapshot.full_name ?? newClientSnapshot.full_name, 'Cliente sin nombre'),
      clientPhone: text(clientSnapshot.phone ?? newClientSnapshot.phone),
      quoteText: text(draft.quote_text),
      totalUsd: number(draft.total_usd, budget.totalUsd),
      totalBs: number(draft.total_bs),
      fxRate: number(draft.fx_rate),
      convertedOrderId: number(draft.converted_order_id) > 0 ? number(draft.converted_order_id) : null,
      updatedAt: text(draft.updated_at ?? draft.created_at),
      budget,
    }];
  });

  return (
    <EventBudgetsClient
      products={products}
      advisors={advisors}
      drafts={drafts}
      activeRate={number(rateResult.data?.rate_bs_per_usd)}
      defaultDate={caracasDate()}
    />
  );
}
