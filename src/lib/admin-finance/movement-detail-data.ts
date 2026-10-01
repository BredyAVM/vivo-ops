import 'server-only';
import { createHash } from 'node:crypto';
import type { requireAdminContext } from '@/lib/auth';
import { movementSnapshot, parseAccountMovement, positiveMovementId } from './movement-detail-model';

type AccountClient = Awaited<ReturnType<typeof requireAdminContext>>['supabase'];
const columns = 'id,money_account_id,movement_group_id,order_id,payment_report_id,movement_date,status,direction,movement_type,currency_code,amount,amount_usd_equivalent,exchange_rate_ves_per_usd,reference_code,counterparty_name,description,notes,void_reason';

// Called only for the selected movement. No per-row lookups or historical ledger scan.
export async function readAccountMovementDetail(client: AccountClient, accountId: number, movementId: number) {
  if (!positiveMovementId(accountId) || !positiveMovementId(movementId)) throw new Error('Movimiento inválido.');
  const selected = await client.from('money_movements').select(columns)
    .eq('id', movementId).eq('money_account_id', accountId).maybeSingle();
  if (selected.error) throw new Error(selected.error.message);
  if (!selected.data) return null;
  const movement = parseAccountMovement(selected.data);
  const group = movement.groupId
    ? await client.from('money_movements').select(columns, { count: 'exact' })
      .eq('movement_group_id', movement.groupId).order('id').limit(501)
    : { data: [selected.data], error: null, count: 1 };
  if (group.error) throw new Error(group.error.message);
  if (!group.data || group.count === null || group.count > 500 || group.count !== group.data.length) {
    throw new Error('No se pudo cargar la operación completa. No es seguro anularla desde este detalle.');
  }
  const movements = group.data.map(parseAccountMovement);
  const currentMovement = movements.find(row => row.id === movementId && row.accountId === accountId);
  if (!currentMovement
    || movements.some(row => row.groupId !== movement.groupId)) throw new Error('La operación cambió. Actualiza la consulta.');
  const ids = [...new Set(movements.map(row => row.accountId))];
  const accounts = await client.from('money_accounts').select('id,name').in('id', ids).limit(501);
  if (accounts.error) throw new Error(accounts.error.message);
  const names: Record<number, string> = {};
  for (const account of accounts.data ?? []) names[Number(account.id)] = String(account.name);
  if (ids.some(id => !names[id])) throw new Error('No se pudieron verificar las cuentas vinculadas.');
  return {
    movement: currentMovement, movements, accountNames: names,
    fingerprint: createHash('sha256').update(movementSnapshot(movements)).digest('hex'),
  };
}
