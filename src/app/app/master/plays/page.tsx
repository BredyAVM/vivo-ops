import { redirect } from 'next/navigation';
import { requireMasterOrAdminContext } from '@/lib/auth';
import MasterPlaysClient, { type MasterPlay, type MasterPlayMember, type PlayBenefit } from './MasterPlaysClient';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SearchParams = Promise<{
  play?: string;
  page?: string;
  q?: string;
  create?: string;
}>;

const MEMBER_PAGE_SIZE = 50;

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export default async function MasterPlaysPage({ searchParams }: { searchParams?: SearchParams }) {
  const ctx = await requireMasterOrAdminContext().catch(() => null);
  if (!ctx) redirect('/app');

  const params = (await searchParams) ?? {};
  const requestedPlayId = Math.max(0, Math.trunc(numberValue(params.play, 0)));
  const requestedPage = Math.max(1, Math.trunc(numberValue(params.page, 1)));
  const search = String(params.q ?? '').trim().slice(0, 80);

  const [playsResult, productsResult] = await Promise.all([
    ctx.supabase
      .from('crm_plays')
      .select(`
        id, series_key, version, name, description, status, rules_snapshot,
        selection_summary, metric_window, gift_product_id, gift_quantity,
        planned_budget_usd, starts_at, ends_at, snapshot_at, activated_at,
        closed_at, created_at
      `)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(100),
    ctx.supabase
      .from('products')
      .select('id, name, sku, type, base_price_usd, advisor_gift_cost_usd:extra_fields->>advisor_gift_cost_usd')
      .eq('is_active', true)
      .in('type', ['product', 'combo', 'promo', 'gambit'])
      .order('name', { ascending: true })
      .limit(300),
  ]);

  if (playsResult.error) throw new Error(playsResult.error.message);
  if (productsResult.error) throw new Error(productsResult.error.message);

  const playIds = (playsResult.data ?? []).map((row) => Number(row.id));
  const benefitOptionsResult = await ctx.supabase
    .from('crm_play_benefits')
    .select(`
      id, play_id, product_id, quantity, unit_budget_cost_usd, sort_order,
      product:products!crm_play_benefits_product_id_fkey(id, name, sku)
    `)
    .in('play_id', playIds.length > 0 ? playIds : [-1])
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (benefitOptionsResult.error) throw new Error(benefitOptionsResult.error.message);

  const benefitOptionsByPlay = new Map<number, MasterPlay['benefits']>();
  for (const row of benefitOptionsResult.data ?? []) {
    const product = one(row.product);
    if (!product) continue;
    const playId = Number(row.play_id);
    const options = benefitOptionsByPlay.get(playId) ?? [];
    options.push({
      id: Number(row.id),
      productId: Number(row.product_id),
      quantity: Number(row.quantity),
      unitBudgetCostUsd: Number(row.unit_budget_cost_usd),
      sortOrder: Number(row.sort_order),
      name: String(product.name),
      sku: product.sku == null ? null : String(product.sku),
    });
    benefitOptionsByPlay.set(playId, options);
  }

  const plays: MasterPlay[] = (playsResult.data ?? []).map((row) => ({
    id: Number(row.id),
    seriesKey: String(row.series_key),
    version: Number(row.version),
    name: String(row.name),
    description: row.description == null ? null : String(row.description),
    status: String(row.status) as MasterPlay['status'],
    rules: row.rules_snapshot && typeof row.rules_snapshot === 'object' && !Array.isArray(row.rules_snapshot)
      ? row.rules_snapshot as Record<string, unknown>
      : {},
    summary: row.selection_summary && typeof row.selection_summary === 'object' && !Array.isArray(row.selection_summary)
      ? row.selection_summary as Record<string, unknown>
      : {},
    metricWindow: Number(row.metric_window),
    giftProductId: Number(row.gift_product_id),
    giftQuantity: Number(row.gift_quantity),
    plannedBudgetUsd: row.planned_budget_usd == null ? null : Number(row.planned_budget_usd),
    startsAt: row.starts_at == null ? null : String(row.starts_at),
    endsAt: row.ends_at == null ? null : String(row.ends_at),
    snapshotAt: row.snapshot_at == null ? null : String(row.snapshot_at),
    activatedAt: row.activated_at == null ? null : String(row.activated_at),
    closedAt: row.closed_at == null ? null : String(row.closed_at),
    createdAt: String(row.created_at),
    benefits: benefitOptionsByPlay.get(Number(row.id)) ?? [],
  }));

  const selectedPlay = plays.find((play) => play.id === requestedPlayId) ?? plays[0] ?? null;
  const createMode = params.create === '1' || !selectedPlay;
  let members: MasterPlayMember[] = [];
  let memberCount = 0;
  let page = requestedPage;

  if (selectedPlay && !createMode) {
    const buildQuery = () => {
      let query = ctx.supabase
        .from('crm_play_members')
        .select(`
          id, play_id, client_id, advisor_id_snapshot, first_purchase_on,
          last_purchase_on, purchase_count, net_revenue_usd, average_ticket_usd,
          last_gift_on, days_since_last_purchase, workflow_status,
          client:clients!inner(id, full_name, phone),
          advisor:profiles!crm_play_members_advisor_id_snapshot_fkey(id, full_name)
        `, { count: 'exact' })
        .eq('play_id', selectedPlay.id);

      if (search) query = query.ilike('clients.full_name', `%${search.replaceAll('%', '').replaceAll('_', '')}%`);
      return query;
    };

    const countResult = await buildQuery().range(0, 0);
    if (countResult.error) throw new Error(countResult.error.message);
    memberCount = countResult.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(memberCount / MEMBER_PAGE_SIZE));
    page = Math.min(requestedPage, totalPages);
    const from = (page - 1) * MEMBER_PAGE_SIZE;
    const to = from + MEMBER_PAGE_SIZE - 1;

    const membersResult = await buildQuery()
      .order('net_revenue_usd', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to);
    if (membersResult.error) throw new Error(membersResult.error.message);

    members = (membersResult.data ?? []).map((row) => {
      const client = one(row.client);
      const advisor = one(row.advisor);
      return {
        id: Number(row.id),
        playId: Number(row.play_id),
        clientId: Number(row.client_id),
        advisorId: row.advisor_id_snapshot == null ? null : String(row.advisor_id_snapshot),
        clientName: client?.full_name?.trim() || 'Cliente sin nombre',
        clientPhone: client?.phone?.trim() || null,
        advisorName: advisor?.full_name?.trim() || 'Sin asesor',
        firstPurchaseOn: row.first_purchase_on == null ? null : String(row.first_purchase_on),
        lastPurchaseOn: row.last_purchase_on == null ? null : String(row.last_purchase_on),
        purchaseCount: Number(row.purchase_count),
        netRevenueUsd: Number(row.net_revenue_usd),
        averageTicketUsd: row.average_ticket_usd == null ? null : Number(row.average_ticket_usd),
        lastGiftOn: row.last_gift_on == null ? null : String(row.last_gift_on),
        daysSinceLastPurchase: row.days_since_last_purchase == null ? null : Number(row.days_since_last_purchase),
        workflowStatus: String(row.workflow_status),
      };
    });
  }

  const benefits: PlayBenefit[] = (productsResult.data ?? []).map((row) => {
    const configuredGiftCost = numberValue(row.advisor_gift_cost_usd, Number.NaN);
    const basePrice = Math.max(0, numberValue(row.base_price_usd, 0));
    return {
      id: Number(row.id),
      name: String(row.name),
      sku: row.sku == null ? null : String(row.sku),
      type: String(row.type),
      referenceBudgetCostUsd: Number.isFinite(configuredGiftCost) && configuredGiftCost >= 0
        ? configuredGiftCost
        : basePrice,
    };
  });

  return (
    <MasterPlaysClient
      roles={ctx.roles}
      plays={plays}
      selectedPlay={createMode ? null : selectedPlay}
      benefits={benefits}
      members={members}
      memberCount={memberCount}
      memberPage={page}
      memberPageSize={MEMBER_PAGE_SIZE}
      memberSearch={search}
    />
  );
}
