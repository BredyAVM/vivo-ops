import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import SharedWorkspace from '@/app/app/admin/_components/SharedWorkspace';
import Link from '@/components/navigation/ContextLink';
type Props = { params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
export const dynamic = 'force-dynamic';
export default async function AdminPlaysPage({ params, searchParams }: Props) {
  await requireAdminContext();
  const path = ((await params).section ?? []).join('/');
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key,value]) => [key, Array.isArray(value) ? value[0] : value]));
  if (path && path !== 'exceptions') notFound();
  if (!path && query.consultar !== '1' && !query.play && query.create !== '1') return <SharedWorkspace title="Jugadas"><nav className="flex flex-wrap gap-2"><Link href="/app/admin/jugadas?consultar=1" prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar jugadas →</Link><Link href="/app/admin/jugadas?create=1" prefetch={false} className="inline-flex min-h-11 items-center px-3 text-xs">Nueva jugada</Link></nav></SharedWorkspace>;
  if (path === 'exceptions') { const { default: Page } = await import('@/app/app/master/plays/exceptions/page'); return <SharedWorkspace title="Excepciones de jugadas"><Page searchParams={Promise.resolve(query)} /></SharedWorkspace>; }
  const { default: Page } = await import('@/app/app/master/plays/page');
  return <SharedWorkspace title="Jugadas"><Page searchParams={Promise.resolve(query)} /></SharedWorkspace>;
}
