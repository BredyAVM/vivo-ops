import 'server-only';
import {requireAdminContext} from '@/lib/auth';
export async function loadAdminCatalogPrices(requested:boolean,page:number){
 const {supabase}=await requireAdminContext();
 if(!requested)return null;
 if(!Number.isSafeInteger(page)||page<1||page>10000)throw new Error('Página inválida.');
 const result=await supabase.from('products').select('id,name,sku,is_active,source_price_amount,source_price_currency').order('name').order('id').range((page-1)*25,page*25);
 if(result.error)throw new Error('No se pudo consultar la lista de precios.');
 const rows=(result.data??[]).slice(0,25).map(r=>{
  const amount=Number(r.source_price_amount);
  if(r.source_price_amount==null||!Number.isFinite(amount)||amount<0||!['USD','VES'].includes(r.source_price_currency))throw new Error('Hay un producto sin precio válido. Revisa su configuración.');
  return {id:Number(r.id),name:String(r.name),sku:r.sku as string|null,isActive:Boolean(r.is_active),amount,currency:r.source_price_currency as 'USD'|'VES'};
 });
 return {rows,hasNext:(result.data??[]).length>25};
}
