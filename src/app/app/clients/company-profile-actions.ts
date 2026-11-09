'use server';

import { requireAuthContext } from '@/lib/auth';
import { normalizeCompanyDocumentData, type ClientCompanyProfile, type CompanyDocumentData } from '@/lib/clients/company-profiles';

async function requireCompanyAccess(clientId: number) {
  const ctx = await requireAuthContext();
  if (!ctx.roles.some(role => ['advisor', 'master', 'admin'].includes(role))) {
    throw new Error('No tienes permiso para gestionar empresas.');
  }
  if (!Number.isSafeInteger(clientId) || clientId <= 0) throw new Error('Selecciona un cliente válido.');
  return ctx;
}

export async function listClientCompaniesAction(clientId: number) {
  const { supabase } = await requireCompanyAccess(clientId);
  const { data, error } = await supabase.from('client_company_profiles')
    .select('id,client_id,label,data,is_default,version').eq('client_id', clientId)
    .order('is_default', { ascending: false }).order('label');
  if (error) {
    console.error('listClientCompaniesAction', { clientId, code: error.code });
    return { ok: false as const, error: 'No se pudieron cargar las empresas. Intenta de nuevo.' };
  }
  return { ok: true as const, profiles: (data ?? []) as ClientCompanyProfile[] };
}

export async function saveClientCompanyAction(input: {
  clientId: number; id: string; expectedVersion: number | null;
  label: string; data: CompanyDocumentData; isDefault: boolean;
}) {
  const { supabase } = await requireCompanyAccess(input.clientId);
  const { data, error } = await supabase.rpc('save_client_company_profile_v1', {
    p_client_id: input.clientId, p_id: input.id, p_expected_version: input.expectedVersion,
    p_label: input.label.trim(), p_data: normalizeCompanyDocumentData(input.data), p_is_default: input.isDefault,
  });
  if (error) {
    console.error('saveClientCompanyAction', { clientId: input.clientId, code: error.code });
    const messages: Record<string, string> = {
      '40001': 'Esta empresa cambió en otra sesión. Recarga las empresas antes de actualizarla.',
      '23505': 'Ya existe una empresa con ese nombre para este cliente. Usa otro nombre.',
      '22023': 'Indica un nombre para la opción y los datos de factura o nota de entrega.',
      '42501': 'No tienes permiso para guardar esta empresa.',
    };
    return { ok: false as const, error: messages[error.code] ?? 'No se pudo guardar la empresa. Tus datos siguen en el formulario; puedes intentar de nuevo.' };
  }
  return { ok: true as const, profiles: data as ClientCompanyProfile[], savedId: input.id };
}
