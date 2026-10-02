import { notFound } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import SharedWorkspace from '@/app/app/admin/_components/SharedWorkspace';
import Link from '@/components/navigation/ContextLink';
type Props = { params: Promise<{ section?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> };
import InventoryNavigation from '@/app/app/inventory/InventoryNavigation';
export const dynamic = 'force-dynamic';
export default async function AdminInventoryPage({ params, searchParams }: Props) {
  await requireAdminContext();
  const segments = (await params).section ?? [];
  const path = segments.join('/');
  const query = await searchParams;
  const body = async () => {
    if (!path) {
      if (query.consultar !== '1') return <Link href="/app/admin/inventario?consultar=1" prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar existencias y disponibilidad →</Link>;
      const { default: Page } = await import('@/app/app/inventory/page'); return <Page />;
    }
    if (path === 'configure') { const { default: Page } = await import('@/app/app/inventory/configure/page'); return <Page searchParams={searchParams} />; }
    if (segments.length === 2 && segments[0] === 'counts' && /^[1-9]\d*$/.test(segments[1])) { const { default: Page } = await import('@/app/app/inventory/counts/[countId]/page'); return <Page params={Promise.resolve({ countId: segments[1] })} />; }
    switch (path) {
      case 'prices': { const {default: Page}=await import('@/app/app/admin/_components/CatalogPrices'); return <Page query={query}/>; }
      case 'products': { const { default: Page } = await import('@/app/app/inventory/products/page'); return <Page />; }
      case 'recipes': { const { default: Page } = await import('@/app/app/inventory/recipes/page'); return <Page />; }
      case 'operations': { const { default: Page } = await import('@/app/app/inventory/operations/page'); return <Page />; }
      case 'counts': { const { default: Page } = await import('@/app/app/inventory/counts/page'); return <Page />; }
      case 'adjustments': { const { default: Page } = await import('@/app/app/inventory/adjustments/page'); return <Page />; }
      case 'alerts': { const { default: Page } = await import('@/app/app/inventory/alerts/page'); return <Page />; }
      case 'incidents': { const { default: Page } = await import('@/app/app/inventory/alerts/page'); return <Page />; }
      case 'reports': { const { default: Page } = await import('@/app/app/inventory/reports/page'); return <Page />; }
      case 'opening': { const { default: Page } = await import('@/app/app/inventory/opening/page'); return <Page />; }
      case 'readiness': { const { default: Page } = await import('@/app/app/inventory/readiness/page'); return <Page />; }
      default: notFound();
    }
  };
  return <SharedWorkspace title="Inventario y catálogo"><InventoryNavigation isAdmin /><div className="min-w-0">{await body()}</div></SharedWorkspace>;
}
