import { redirect } from 'next/navigation';
export default async function AdminTasksPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const query = new URLSearchParams({ bandeja: 'seguimiento' });
  for (const [key, value] of Object.entries(params)) {
    if (key === 'bandeja') continue;
    for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) query.append(key, item);
  }
  redirect(`/app/admin/autorizaciones?${query}`);
}
