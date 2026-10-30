'use server';

import { requireAuthContext } from '@/lib/auth';
import { isMenuId } from './menu-model';
import { decodeOrderMenuGraph, parseMenuOrderSelection, readMenuOrderQuote, MUERDEME_DETAIL_PREFIX } from './order-menu';

async function seller() {
  const ctx = await requireAuthContext();
  if (!ctx.roles.some(role => ['admin', 'master', 'advisor'].includes(role))) throw new Error('Requiere permisos de ventas.');
  return ctx;
}
export async function searchMuerdemeOrderMenu(query = '', kind: string | null = null, page = 1) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function loadMuerdemeOrderMenu(entryId: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function quoteMuerdemeOrderProduct(raw: unknown, revisions: Record<string, number>) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
