import { notFound } from 'next/navigation';
import Link from '@/components/navigation/ContextLink';
import { isMenuKind } from '@/lib/brands/menu-model';
import MenuEditorPage from '../_components/MenuEditorPage';
export const dynamic = 'force-dynamic';
export default async function NewMuerdemeMenuPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  const kind = query.tipo ?? 'burger';
  if (!isMenuKind(kind)) notFound();
  if (kind === 'drink') return <div className="space-y-3 text-xs text-[#BDBDC7]"><h1 className="text-lg font-semibold text-[#DEDEE6]">Bebidas compartidas con VIVO</h1><p>Selecciona las bebidas existentes al configurar un combo. Se utiliza el mismo producto y su inventario, sin crear otra bebida en Muérdeme.</p><Link href="/app/admin/negocio/marcas/muerdeme/catalogo" prefetch={false} className="inline-flex min-h-11 items-center text-[#FFFF00]">Volver al catálogo</Link></div>;
  return <MenuEditorPage entryId={null} kind={kind} query={query} />;
}
