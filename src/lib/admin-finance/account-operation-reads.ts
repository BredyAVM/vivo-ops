import 'server-only';
import type { requireAdminContext } from '@/lib/auth';

type AccountClient = Awaited<ReturnType<typeof requireAdminContext>>['supabase'];

export async function readReconciliationReview(client: AccountClient, itemId: number, query: string) {
  return client.rpc('admin_account_reconciliation_detail_v1', { p_item_id: itemId, p_query: query.slice(0, 120) });
}

export async function resolveReconciliation(client: AccountClient, requestId: string, payload: object) {
  return client.rpc('resolve_account_reconciliation_v1', { p_request_id: requestId, p_input: payload });
}

export async function undoReconciliation(client: AccountClient, requestId: string, reason: string) {
  return client.rpc('undo_account_reconciliation_v1', { p_request_id: requestId, p_reason: reason });
}

export async function voidClosure(client: AccountClient, closureId: number, reason: string) {
  return client.rpc('void_account_closure_v1', { p_closure_id: closureId, p_reason: reason });
}

export async function createCashOperation(client: AccountClient, requestId: string, payload: object) {
  return client.rpc('create_admin_cash_operation_v1', { p_request_id: requestId, p_input: payload });
}

export async function readAccountName(client: AccountClient, accountId: number) {
  return client.from('money_accounts').select('name').eq('id', accountId).single();
}

export async function readClosureReview(client: AccountClient, id: number) {
  return Promise.all([
    client.from('money_account_closures').select('*').eq('id', id).maybeSingle(),
    client.from('money_account_reconciliation_items').select('id,description,status,amount,currency_code').eq('source_kind', 'closure').eq('source_id', id).order('id').limit(501),
    client.from('account_closure_reversals').select('*').eq('closure_id', id).maybeSingle(),
  ]);
}

export async function readCashOperation(client: AccountClient, requestId: string) {
  return client.from('account_cash_operations').select('*').eq('request_id', requestId).maybeSingle();
}

export async function readCashOperationMovements(client: AccountClient, requestId: string) {
  return client.from('money_movements').select('id,status,amount,currency_code,movement_type,void_reason').eq('movement_group_id', requestId).order('id');
}
