import 'server-only';
import { requireAdminContext } from '@/lib/auth';


export type DeliveryPaymentInput = {
  from: string; to: string; paymentDate: string;
  items: { id: number; fingerprint: string }[];
  accountId: number | null; amount: number | null; rate: number | null;
  existingMovementId: number | null; reference: string; notes: string;
  confirmedUnpaid: boolean; confirmTariffs: boolean;
};
export async function persistDeliveryPayment(requestId: string, input: DeliveryPaymentInput) {
  const { supabase } = await requireAdminContext();
  if (!/^[a-f0-9-]{36}$/i.test(requestId) || !Array.isArray(input.items) || input.items.length > 500) return { ok: false as const, message: 'Solicitud inválida.' };
  const { data, error } = await supabase.rpc('pay_delivery_services_v1', { p_request_id: requestId, p_input: input });
  if (error) return { ok: false as const, message: error.message };
  if (!data || !Number.isSafeInteger(data.movementId) || typeof data.totalUsd !== 'number')
    return { ok: false as const, message: 'No se pudo verificar la respuesta. Reintenta sin cambiar los datos: el envío está protegido contra duplicados.' };
  return { ok: true as const, movementId: data.movementId as number, totalUsd: data.totalUsd as number };
}

export async function loadDeliveryServices(from: string, to: string) {
  const { supabase } = await requireAdminContext();
  const [report, accounts, payments] = await Promise.all([
    supabase.rpc('admin_delivery_services_v1', { p_from: from, p_to: to }),
    supabase.from('money_accounts').select('id,name,currency_code').eq('is_active', true).order('name'),
    supabase.from('delivery_service_payments').select('request_id,responsible_name,responsible_key,total_usd,period_from,period_to,voided_at')
      .lte('period_from', to).gte('period_to', from).order('created_at', { ascending: false }).limit(30),
  ]);
  if (report.error) throw new Error(report.error.message);
  if (accounts.error) throw new Error('No se pudieron cargar las cuentas de pago.');
  if (payments.error) throw new Error('No se pudo cargar el historial de pagos.');
  return { report: report.data, accounts: accounts.data ?? [], payments: payments.data ?? [] };
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
