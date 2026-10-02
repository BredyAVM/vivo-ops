import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import SharedWorkspace from '@/app/app/admin/_components/SharedWorkspace';
import Link from '@/components/navigation/ContextLink';
type Props = { params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = 'force-dynamic';
export default async function AdminEventsPage({ params, searchParams }: Props) {
  await requireAdminContext();
  const segments = (await params).section ?? [];
  if (!segments.length) {
    const query=await searchParams;
    if (query.consultar !== '1') return <SharedWorkspace title="Eventos"><nav className="flex flex-wrap gap-2"><Link href="/app/admin/eventos?consultar=1" prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar y preparar presupuestos →</Link><Link href="/app/admin/eventos/ongoing" prefetch={false} className="inline-flex min-h-11 items-center px-3 text-xs">Eventos en curso</Link></nav></SharedWorkspace>;
    const { default: Page }=await import('@/app/app/events/page'); return <SharedWorkspace title="Presupuestos de eventos"><Page /></SharedWorkspace>;
  }
  if (segments.length===1 && segments[0]==='ongoing') { const { default: Page }=await import('@/app/app/events/ongoing/page'); return <SharedWorkspace title="Eventos en curso"><Page /></SharedWorkspace>; }
  if (segments.length===1 && /^[1-9]\d*$/.test(segments[0])) { const { default: Page }=await import('@/app/app/events/[id]/page'); return <SharedWorkspace title="Evento"><Page params={Promise.resolve({id:segments[0]})} /></SharedWorkspace>; }
  notFound();
}
