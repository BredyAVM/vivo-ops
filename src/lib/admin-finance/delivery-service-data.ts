import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { parseDeliveryExtras, type DeliveryExtraInput } from './delivery-extras';
import { parseDeliveryDebts, type DeliveryDebtInput, type DeliveryDeduction } from './delivery-debts';


export type DeliveryPaymentInput = {
  from: string; to: string; paymentDate: string;
  items: { id: number; fingerprint: string }[];
  extras?: { id: string; fingerprint: string }[];
  deductions?: DeliveryDeduction[];
  accountId: number | null; amount: number | null; rate: number | null;
  existingMovementId: number | null; reference: string; notes: string;
  confirmedUnpaid: boolean; confirmTariffs: boolean;
};
export async function persistDeliveryPayment(requestId: string, input: DeliveryPaymentInput) {
  const { supabase } = await requireAdminContext();
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !Array.isArray(input.items) || input.items.length > 500) return { ok: false as const, message: 'Solicitud inválida.' };
  const { data, error } = await supabase.rpc('pay_delivery_services_v1', { p_request_id: requestId, p_input: input });
  if (error) return { ok: false as const, message: error.message };
  if (!data || !(Number.isSafeInteger(data.movementId) || (data.movementId === null && data.totalUsd === 0)) || typeof data.totalUsd !== 'number')
    return { ok: false as const, message: 'No se pudo verificar la respuesta. Reintenta sin cambiar los datos: el envío está protegido contra duplicados.' };
  return { ok: true as const, movementId: data.movementId as number | null, totalUsd: data.totalUsd as number };
}

export async function loadDeliveryServices(from: string, to: string) {
  const { supabase } = await requireAdminContext();
  const [report, accounts, payments, extras, debts] = await Promise.all([
    supabase.rpc('admin_delivery_services_v1', { p_from: from, p_to: to }),
    supabase.from('money_accounts').select('id,name,currency_code').eq('is_active', true).order('name'),
    supabase.from('delivery_service_payments').select('request_id,responsible_name,responsible_key,total_usd,period_from,period_to,voided_at')
      .lte('period_from', to).gte('period_to', from).order('created_at', { ascending: false }).limit(30),
    supabase.rpc('admin_delivery_extras_v1', { p_from: from, p_to: to }),
    supabase.rpc('admin_delivery_debts_v1', { p_to: to }),
  ]);
  if (report.error) throw new Error(report.error.message);
  if (accounts.error) throw new Error('No se pudieron cargar las cuentas de pago.');
  if (payments.error) throw new Error('No se pudo cargar el historial de pagos.');
  if (extras.error) throw new Error('No se pudieron cargar los servicios adicionales.');
  if (debts.error) throw new Error('No se pudieron cargar las deudas. No se registró ningún descuento.');
  return { report: report.data, accounts: accounts.data ?? [], payments: payments.data ?? [], extras: parseDeliveryExtras(extras.data, from, to), debts: parseDeliveryDebts(debts.data, to) };
}

export async function persistDeliveryDebt(id: string, input: DeliveryDebtInput) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('create_delivery_debt_v1', { p_request_id: id, p_input: input });
  if (error) return { ok: false as const, message: error.code === '23505' ? 'Ese pedido ya está vinculado a una deuda. Revisa el registro existente.' : error.message };
  return data?.id === id ? { ok: true as const, message: 'Deuda registrada.' } : { ok: false as const, message: 'Respuesta no verificada. Reintenta sin cambiar los datos.' };
}
export async function reverseDeliveryDebt(id: string, reason: string) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('void_delivery_debt_v1', { p_id: id, p_reason: reason });
  if (error) return { ok: false as const, message: error.message };
  return { ok: data?.voided === true, message: data?.voided ? 'Deuda anulada; se conserva su historial.' : 'Respuesta no verificada. Actualiza antes de reintentar.' };
}
export async function previewDeliveryDebtOrder(id: number) {
  const { supabase } = await requireAdminContext();
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false as const, message: 'Indica el número corto del pedido.' };
  const [order, state] = await Promise.all([
    supabase.from('orders').select('id,client_id,clients(full_name)').eq('id', id).single(),
    supabase.rpc('get_order_financial_state', { p_order_id: id }),
  ]);
  const s = Array.isArray(state.data) ? state.data[0] : null;
  if (order.error || state.error || !order.data?.client_id || !s || s.order_status === 'cancelled' || Number(s.pending_usd) <= 0)
    return { ok: false as const, message: 'Pedido no disponible o sin saldo pendiente.' };
  if (s.pending_reports_count > 0) return { ok: false as const, message: 'Revisa primero los pagos reportados del pedido.' };
  const c = order.data.clients as unknown as { full_name: string } | null;
  return { ok: true as const, orderId: id, clientId: Number(order.data.client_id), client: c?.full_name || 'Cliente', amount: Math.round(Number(s.pending_usd) * 100) / 100 };
}

export async function persistDeliveryExtra(id: string, input: DeliveryExtraInput) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('create_delivery_extra_v1', { p_request_id: id, p_input: input });
  if (error) return { ok: false as const, message: error.message };
  return data?.id === id ? { ok: true as const, message: 'Servicio guardado.' } : { ok: false as const, message: 'Respuesta no verificada. Reintenta sin cambiar los datos.' };
}
export async function reverseDeliveryExtra(id: string, reason: string) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('void_delivery_extra_v1', { p_id: id, p_reason: reason });
  if (error) return { ok: false as const, message: error.message };
  return data?.voided === true ? { ok: true as const, message: 'Servicio anulado; se conserva el historial.' } : { ok: false as const, message: 'Respuesta no verificada. Actualiza antes de reintentar.' };
}

export async function loadDeliveryPayment(id: string) {
  const { supabase } = await requireAdminContext();
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Pago inválido.');
  const { data, error } = await supabase.from('delivery_service_payments')
    .select('request_id,responsible_name,total_usd,period_from,period_to,created_at,voided_at,void_reason,result,evidence')
    .eq('request_id', id).single();
  if (error || !data) throw new Error('No se pudo cargar el pago.');
  return data;
}

export async function reverseDeliveryPayment(id: string, reason: string) {
  const { supabase } = await requireAdminContext();
  const { data, error } = await supabase.rpc('void_delivery_service_payment_v1', { p_payment_id: id, p_reason: reason });
  if (error) return { ok: false as const, message: error.message };
  return { ok: data?.voided === true, message: data?.voided ? 'Registro anulado. El historial se conserva.' : 'Respuesta no verificada; actualiza antes de reintentar.' };
}
