import { getAuthContext, isAdminRole } from '@/lib/auth';
import { loadAdminReport } from '@/lib/admin-finance/reports-data';
import type { DeliveryRpcClient } from '@/lib/admin-finance/delivery-data';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
  const ctx = await getAuthContext();
  if (!ctx) return Response.json({ error: 'Inicia sesión para descargar el reporte.' }, { status: 401, headers });
  if (!isAdminRole(ctx.roles)) return Response.json({ error: 'Acceso reservado a Administración.' }, { status: 403, headers });
  const domain = new URL(request.url).searchParams.get('dominio');
  if (domain !== 'cuentas' && domain !== 'pedidos') return Response.json({ error: 'Reporte no válido.' }, { status: 400, headers });
  const result = await loadAdminReport(ctx.supabase as unknown as DeliveryRpcClient, domain);
  if (result.status === 'error') return Response.json({ error: result.message }, { status: 503, headers });
  return new Response(result.csv, { headers: { ...headers, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="vivo-${domain}-${result.asOf.slice(0,10)}.csv"`, 'X-Report-As-Of': result.asOf, 'X-Report-Rows': String(result.count) } });
}
