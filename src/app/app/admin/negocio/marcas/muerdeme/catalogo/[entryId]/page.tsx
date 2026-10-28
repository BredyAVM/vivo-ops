import { notFound } from 'next/navigation';
import { isMenuId } from '@/lib/brands/menu-model';
import MenuEditorPage from '../_components/MenuEditorPage';
export const dynamic = 'force-dynamic';
export default async function EditMuerdemeMenuPage({ params, searchParams }: {
  params: Promise<{ entryId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { entryId } = await params;
  if (!isMenuId(entryId)) notFound();
  const raw = await searchParams;
  const query = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value]));
  return <MenuEditorPage entryId={entryId} kind="burger" query={query} />;
}
