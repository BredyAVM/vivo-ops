'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireAdminContext } from '@/lib/auth';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';
import { isMenuId, menuRoot, parseMenuDocument } from './menu-model';

export type MenuSaveState = { error: string };
export async function saveMuerdemeMenuDraft(_previous: MenuSaveState, form: FormData): Promise<MenuSaveState> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
