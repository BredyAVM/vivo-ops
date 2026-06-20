import Link from 'next/link';
import { getAuthContext } from '@/lib/auth';
import { EmptyBlock, PageIntro, SectionCard, StatusBadge } from '../advisor-ui';

type DraftRow = {
  id: number;
  status: string | null;
  title: string | null;
  client_id: number | string | null;
  client_snapshot: Record<string, unknown> | null;
  new_client_snapshot: Record<string, unknown> | null;
  total_usd: number | string | null;
  total_bs: number | string | null;
  fx_rate: number | string | null;
  quoted_at: string | null;
  updated_at: string | null;
};

function formatUsd(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return `$${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return 'Sin fecha';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-VE', {
    day: '2-digit',
    month: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function getSnapshotText(snapshot: Record<string, unknown> | null | undefined, key: string) {
  return String(snapshot?.[key] || '').trim();
}

function getDraftClientLabel(draft: DraftRow) {
  const existingName = getSnapshotText(draft.client_snapshot, 'full_name');
  if (existingName) return existingName;
  const newName = getSnapshotText(draft.new_client_snapshot, 'fullName') || getSnapshotText(draft.new_client_snapshot, 'full_name');
  if (newName) return newName;
  return 'Cliente sin seleccionar';
}

function getDraftStatusLabel(status: string | null | undefined) {
  return status === 'quoted' ? 'Cotizado' : 'Borrador';
}

export default async function AdvisorDraftsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data, error } = await ctx.supabase
    .from('advisor_order_drafts')
    .select('id, status, title, client_id, client_snapshot, new_client_snapshot, total_usd, total_bs, fx_rate, quoted_at, updated_at')
    .eq('advisor_user_id', ctx.user.id)
    .in('status', ['draft', 'quoted'])
    .order('updated_at', { ascending: false })
    .limit(80);

  const drafts = (data ?? []) as DraftRow[];

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Pedidos"
        title="Borradores y cotizados"
        description="Pedidos que todavia no entran a agenda. Cotizado significa que ya se copio para WhatsApp y conserva precios y tasa."
        action={
          <Link href="/app/advisor/new" className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-sm font-semibold text-[#17191E]">
            Nuevo
          </Link>
        }
      />

      <SectionCard title="Pendientes de confirmar" subtitle={`${drafts.length} abierto${drafts.length === 1 ? '' : 's'}`}>
        {error ? (
          <EmptyBlock
            title="Falta activar la tabla de borradores"
            detail={error.message || 'Corre el SQL de advisor_order_drafts y vuelve a entrar.'}
          />
        ) : drafts.length === 0 ? (
          <EmptyBlock
            title="No hay borradores"
            detail="Cuando guardes un borrador o copies un presupuesto para WhatsApp, aparecera aqui."
            href="/app/advisor/new"
            cta="Crear uno"
          />
        ) : (
          <div className="space-y-3">
            {drafts.map((draft) => (
              <article key={draft.id} className="rounded-[18px] border border-[#232632] bg-[#0D1017] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-[15px] font-semibold text-[#F5F7FB]">
                        {draft.title || getDraftClientLabel(draft)}
                      </h3>
                      <StatusBadge
                        label={getDraftStatusLabel(draft.status)}
                        tone={draft.status === 'quoted' ? 'warning' : 'neutral'}
                      />
                    </div>
                    <p className="mt-1 text-xs text-[#AAB2C5]">{getDraftClientLabel(draft)}</p>
                    <p className="mt-1 text-xs text-[#6F7890]">
                      Actualizado {formatUpdatedAt(draft.updated_at)}
                      {draft.quoted_at ? ` · Cotizado ${formatUpdatedAt(draft.quoted_at)}` : ''}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-base font-semibold text-[#F5F7FB]">{formatUsd(draft.total_usd)}</div>
                    <div className="text-[11px] text-[#8B93A7]">
                      Tasa {Number(draft.fx_rate || 0) > 0 ? Number(draft.fx_rate).toFixed(2) : '-'}
                    </div>
                  </div>
                </div>

                <Link
                  href={`/app/advisor/new?draftId=${draft.id}`}
                  className="mt-3 inline-flex h-10 w-full items-center justify-center rounded-[14px] border border-[#2A3040] text-sm font-semibold text-[#F5F7FB]"
                >
                  Abrir
                </Link>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
