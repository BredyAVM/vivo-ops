import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeRemoteSearchValue } from './normalize-search';

export type ClientSearchSummary = {
  id: number;
  full_name: string;
  phone: string | null;
  primary_advisor_id: string | null;
};

/** Directory results do not depend on the existence of an operational order. */
export async function searchClientSummaries(supabase: SupabaseClient, input: string, limit = 8): Promise<ClientSearchSummary[]> {
  const query = normalizeRemoteSearchValue(input);
  if (query.length < 2) return [];
  const { data, error } = await supabase.rpc('search_clients_unaccent', {
    p_query: query,
    p_limit: Math.max(1, Math.min(20, Math.floor(limit))),
  }).select('id,full_name,phone,primary_advisor_id');
  if (error) throw new Error(error.message);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((row) => ({
    id: Number(row.id),
    full_name: String(row.full_name || 'Sin nombre'),
    phone: row.phone ? String(row.phone) : null,
    primary_advisor_id: row.primary_advisor_id ? String(row.primary_advisor_id) : null,
  }));
}
