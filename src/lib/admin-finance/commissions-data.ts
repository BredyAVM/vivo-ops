import 'server-only';
import { parseCommissionsOverview, type CommissionsOverview } from './commissions-model';
export type CommissionsRpcClient = {
  rpc: (name: string, params: Record<string, unknown>) => Promise<{ data: unknown; error: { message?: string } | null }>;
};
export async function loadCommissionsOverview(input: { supabase: CommissionsRpcClient; asOf?: Date }): Promise<
  { status: 'ready'; data: CommissionsOverview } | { status: 'error'; message: string }
> {
  const requestedAt = input.asOf ?? new Date();
  try {
    const result = await input.supabase.rpc('admin_finance_commissions_read_v2', {});
    if (result.error) throw new Error(result.error.message || 'Commission read failed');
    return { status: 'ready', data: parseCommissionsOverview(result.data, requestedAt) };
  } catch (error) {
    console.warn('admin commissions unavailable', error instanceof Error ? error.message : 'unknown');
    return { status: 'error', message: 'No pudimos cargar las comisiones. Ninguna liquidación ni pago fue modificado.' };
  }
}
