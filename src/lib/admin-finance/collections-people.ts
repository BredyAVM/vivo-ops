import 'server-only';
import { requireAdminContext } from '@/lib/auth';

// Only called by "Cargar vendedores". No financial data is read here.
export async function loadCollectionPeople() {
  const { supabase } = await requireAdminContext();
  const people: { id: string; name: string }[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('profiles').select('id,full_name,is_active')
      .order('full_name').order('id').range(offset, offset + 499);
    if (error || !data) throw new Error('No pudimos cargar la lista de vendedores.');
    for (const row of data) people.push({ id: row.id, name: `${row.full_name?.trim() || 'Sin nombre'}${row.is_active === false ? ' (inactivo)' : ''}` });
    if (data.length < 500) return people;
  }
}
