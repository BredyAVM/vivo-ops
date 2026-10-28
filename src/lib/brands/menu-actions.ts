'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';
import { isMenuId, menuRoot, parseMenuDocument } from './menu-model';

export type MenuSaveState = { error: string };
export async function saveMuerdemeMenuDraft(_previous: MenuSaveState, form: FormData): Promise<MenuSaveState> {
  let destination = '';
  try {
    const { supabase } = await requireAdminContext();
    const raw = form.get('document');
    if (typeof raw !== 'string' || raw.length > 60000) throw new Error('La configuración está incompleta o es demasiado extensa.');
    const document = parseMenuDocument(JSON.parse(raw));
    const entryId = String(form.get('entryId') ?? '') || null;
    const expectedText = String(form.get('revision') ?? '');
    const expected = Number(expectedText);
    const operationId = String(form.get('operationId') ?? '');
    if ((entryId !== null && !isMenuId(entryId)) || !isMenuId(operationId)
      || !/^\d+$/.test(expectedText) || !Number.isSafeInteger(expected)
      || (entryId === null ? expected !== 0 : expected < 1)) {
      throw new Error('Vuelve a abrir el producto antes de guardar.');
    }
    const { data, error } = await supabase.rpc('admin_muerdeme_menu_save_v1', {
      p_entry_id: entryId, p_expected_revision: expected, p_document: document, p_operation_id: operationId,
    });
    if (error) {
      if (error.code === '40001') throw new Error('El producto cambió. Vuelve a consultarlo antes de guardar.');
      if (error.code === '42501') throw new Error('Esta operación requiere un administrador activo.');
      if (error.code === '22023') throw new Error(error.message);
      throw new Error('No se pudo guardar. Consulta el producto antes de reintentar.');
    }
    if (!data || !isMenuId(data.entryId) || data.revision !== expected + 1
      || (entryId !== null && data.entryId !== entryId)) throw new Error('No se pudo verificar el guardado. Vuelve a consultar el catálogo.');
    const requestedReturn = safeAppReturnHref(form.get('returnTo'));
    const returnTo = requestedReturn && requestedReturn.split('?')[0] === menuRoot ? requestedReturn : menuRoot;
    destination = `${menuRoot}/${data.entryId}?` + new URLSearchParams({ guardado: '1', returnTo });
    revalidatePath(menuRoot);
    revalidatePath(`${menuRoot}/${data.entryId}`);
  } catch (error) {
    return { error: error instanceof SyntaxError ? 'La configuración está incompleta.' : error instanceof Error ? error.message : 'No se pudo guardar el producto.' };
  }
  redirect(destination);
}
