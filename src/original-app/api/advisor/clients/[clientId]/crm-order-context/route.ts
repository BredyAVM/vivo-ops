import { NextResponse } from 'next/server';
import { getAuthContext, isAdvisorRole, isMasterOrAdminRole } from '@/lib/auth';
import { loadAdvisorCrmOrderContext } from '@/lib/crm/advisor-order-context';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ clientId: string }> },
) {
  try {
    const ctx = await getAuthContext();
    if (!ctx) return NextResponse.json({ error: 'No autenticado.' }, { status: 401 });
    if (!isAdvisorRole(ctx.roles) && !isMasterOrAdminRole(ctx.roles)) {
      return NextResponse.json({ error: 'No autorizado.' }, { status: 403 });
    }

    const { clientId: rawClientId } = await params;
    const clientId = Math.trunc(Number(rawClientId));
    if (!Number.isFinite(clientId) || clientId <= 0) {
      return NextResponse.json({ error: 'El cliente no es válido.' }, { status: 400 });
    }

    const context = await loadAdvisorCrmOrderContext({
      supabase: ctx.supabase,
      advisorUserId: ctx.user.id,
      clientId,
    });

    return NextResponse.json({ context });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'No se pudo revisar la jugada del cliente.' },
      { status: 500 },
    );
  }
}
