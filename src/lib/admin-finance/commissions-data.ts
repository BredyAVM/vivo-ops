import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCommissionLiveCollections } from '../commissions/live-collections.ts';
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
    const overview = parseCommissionsOverview(result.data, requestedAt);
    const version = result.data && typeof result.data === 'object' && 'definitionVersion' in result.data ? result.data.definitionVersion : null;
    if (version === 'admin-finance-commissions-v2') {
      const candidates = overview.rows.filter((row) => row.retainedBasis === 'snapshot' && ((row.retainedUsd ?? 0) > 0 || row.referencedPaidUsd > row.payableUsd));
      for (let offset = 0; offset < candidates.length; offset += 100) {
        const states = await loadCommissionLiveCollections(input.supabase as unknown as SupabaseClient, candidates.slice(offset,offset+100).map((row) => row.id));
        for (const row of candidates.slice(offset,offset+100)) {
          const state = states.get(row.id);
          if (!state?.supported) throw new Error('La cobranza del resumen no se pudo verificar.');
          row.retainedUsd = state.retainedUsd;
          if (row.conformed && row.paymentBasis !== 'legacy' && Math.abs(row.referencedPaidUsd-state.paidUsd)<0.005) {
            row.pendingUsd = state.pendingUsd;
            if (state.overpaidUsd === 0) row.issues = row.issues.filter((issue) => issue !== 'Abonos identificados superiores a liquidación');
            else row.issues.push('Pagos superiores al disponible actual: revisar cobranza');
          }
        }
      }
    }
    return { status: 'ready', data: overview };
  } catch (error) {
    console.warn('admin commissions unavailable', error instanceof Error ? error.message : 'unknown');
    return { status: 'error', message: 'No pudimos cargar las comisiones. Ninguna liquidación ni pago fue modificado.' };
  }
}
