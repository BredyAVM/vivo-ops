'use server';

import { requireAdminContext, requireAuthContext } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { isMenuId, menuRoot, parseMenuDocument, type MenuDocument } from './menu-model';
import { parseMenuOrderSelection } from './order-menu';
import { parseMenuStockRecipe, readMenuStockSnapshot, MUERDEME_STOCK_PREFIX, type MenuStockRecipe, type MenuStockItem } from './inventory-menu';

export type MenuStockEditorData = {
  entryId:string;menuRevision:number;menu:MenuDocument;variantKey:string;
  recipe:null|{revision:number;document:MenuStockRecipe;updatedAt:string;signatureMatches:boolean};items:MenuStockItem[];hasMore:boolean;
};
export async function loadMuerdemeStockEditor(entryId:string,variantKey:string|null,query=''):Promise<MenuStockEditorData|null>{ throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function saveMuerdemeStockRecipe(_previous:{error:string},form:FormData):Promise<{error:string}>{ throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function previewMuerdemePreparation(selection:unknown,revisions:Record<string,number>){ throw new Error('All business actions are disabled in the CPU benchmark.'); }
