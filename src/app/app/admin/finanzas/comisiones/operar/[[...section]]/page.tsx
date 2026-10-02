import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import SharedWorkspace from '@/app/app/admin/_components/SharedWorkspace';
import Link from '@/components/navigation/ContextLink';
type Props = { params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = 'force-dynamic';
export default async function AdminCommissionWorkspacePage({ params, searchParams }: Props) {
  await requireAdminContext();
  const segments = (await params).section ?? [];
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key,value]) => [key,Array.isArray(value)?value[0]:value]));
  if (!segments.length) {
    if (query.consultar !== '1' && !query.period) return <SharedWorkspace title="Operar comisiones"><nav className="flex flex-wrap gap-2"><Link href="/app/admin/finanzas/comisiones/operar?consultar=1" prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar períodos y liquidaciones →</Link><Link href="/app/admin/finanzas/comisiones/operar/goals" prefetch={false} className="inline-flex min-h-11 items-center px-3 text-xs">Configurar metas</Link></nav></SharedWorkspace>;
    const {default: Page}=await import('@/app/app/commissions/page'); return <SharedWorkspace title="Comisiones y liquidaciones"><Page searchParams={Promise.resolve(query)} /></SharedWorkspace>;
  }
  if (segments.length===1 && segments[0]==='goals') { const {default: Page}=await import('@/app/app/commissions/goals/page'); return <SharedWorkspace title="Metas de asesores"><Page searchParams={Promise.resolve(query)} /></SharedWorkspace>; }
  if (segments.length===1 && /^[1-9]\d*$/.test(segments[0])) { const {default: Page}=await import('@/app/app/commissions/[closureId]/page'); return <SharedWorkspace title="Liquidación"><Page params={Promise.resolve({closureId:segments[0]})} searchParams={Promise.resolve(query)} /></SharedWorkspace>; }
  notFound();
}
