import {getAuthContext,isAdminRole} from '@/lib/auth';
import {analysisFilters} from '@/lib/admin-finance/commercial-analysis-model';
import {loadCommercialAnalysis} from '@/lib/admin-finance/commercial-analysis-data';
import {adminCsv} from '@/lib/admin-finance/reports-model';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
 const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
 const ctx=await getAuthContext();
 if(!ctx)return Response.json({error:'Inicia sesión para descargar.'},{status:401,headers});
 if(!isAdminRole(ctx.roles))return Response.json({error:'Solo Administración.'},{status:403,headers});
 try{
  const params=Object.fromEntries(new URL(request.url).searchParams);
  const filters=analysisFilters({...params,details:'none'});
  const data=await loadCommercialAnalysis(filters,true);
  if(!data)throw new Error('Selecciona un período.');
  const csv=adminCsv([
   ['Corte UTC','Desde','Hasta','Fecha utilizada','Responsabilidad filtrada','Orden corta','Cliente','Vendedor','Canal','Entrega','Fecha Caracas','Facturación neta USD','Total orden USD','Abonado actual USD','Pendiente actual USD'],
   ...data.rows.map(r=>[data.asOf,filters.from,filters.to,filters.basis,filters.personBasis,r.id,r.client,r.personName,r.source,r.fulfillment,r.date,r.netUsd,r.totalUsd,r.paidUsd,r.pendingUsd]),
  ]);
  return new Response(csv,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="vivo-ventas-${filters.from}-${filters.to}.csv"`,'X-Report-Rows':String(data.rows.length),'X-Report-As-Of':data.asOf}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'No se pudo consultar.'},{status:503,headers})}
}
