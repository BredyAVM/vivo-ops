import { notFound } from 'next/navigation';
import { isMenuKind } from '@/lib/brands/menu-model';
import MenuEditorPage from '../_components/MenuEditorPage';
export const dynamic = 'force-dynamic';
export default async function NewMuerdemeMenuPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  const kind = query.tipo ?? 'burger';
  if (!isMenuKind(kind)) notFound();
  return <MenuEditorPage entryId={null} kind={kind} query={query} />;
}
