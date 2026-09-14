'use client';

import { useRef, useState, useTransition, type RefObject } from 'react';
import { deliveryServiceTotals, type DeliveryService } from '@/lib/admin-finance/delivery-services';
import { recordDeliveryPayment, type DeliveryPaymentInput } from './actions';

export type DeliveryPaymentAttempt = { id: string; payload: string } | null;
export type DeliveryMoneyAccount = { id: number; name: string; currency_code: string };
export const deliveryInput = 'min-h-11 min-w-0 rounded-md border border-[#30303D] bg-[#14141C] px-2 text-xs text-white md:min-h-8 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[#FEEF00]';
export const deliveryButton = `${deliveryInput} hover:bg-[#22222C]`;
export const deliveryPrimaryButton = 'min-h-11 rounded-md bg-[#FEEF00] px-3 text-xs font-semibold text-black hover:bg-yellow-200 md:min-h-8 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white';
const usd = (n: number) => `$${n.toFixed(2)}`;

export default function DeliveryPaymentForm({ rows, accounts, from, to, today, partial, attempt, onClose, onPaid }: {
  rows: DeliveryService[]; accounts: DeliveryMoneyAccount[]; from: string; to: string; today: string; partial: boolean;
  attempt: RefObject<DeliveryPaymentAttempt>;
  onClose: () => void; onPaid: (receipt: { id: string; movementId: number; total: number }) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [rate, setRate] = useState('');
  const [method, setMethod] = useState('new');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const total = deliveryServiceTotals(rows).amount;
  const tariffCount = rows.filter(row => row.cost.stored === null).length;
  const account = accounts.find(row => String(row.id) === accountId);
  const native = account?.currency_code === 'VES' ? total * Number(rate || 0) : total;

  function submit(form: FormData) {
    if (submitting.current) return;
    const input: DeliveryPaymentInput = {
      from, to, paymentDate: String(form.get('paymentDate')),
      items: rows.map(row => ({ id: row.id, fingerprint: row.cost.fingerprint })),
      accountId: method === 'new' ? Number(accountId) : null,
      amount: method === 'new' ? Number(form.get('amount')) : null,
      rate: method === 'new' && account?.currency_code === 'VES' ? Number(rate) : null,
      existingMovementId: method === 'existing' ? Number(form.get('existingMovementId')) : null,
      reference: String(form.get('reference') || ''), notes: String(form.get('notes') || ''),
      confirmedUnpaid: form.get('confirmedUnpaid') === 'on', confirmTariffs: form.get('confirmTariffs') === 'on',
    };
    const payload = JSON.stringify(input);
    if (!attempt.current || attempt.current.payload !== payload) attempt.current = { id: crypto.randomUUID(), payload };
    const requestId = attempt.current.id;
    submitting.current = true;
    setMessage('');
    startTransition(async () => {
      try {
        const result = await recordDeliveryPayment(requestId, input);
        if (!result.ok) { setMessage(result.message); return; }
        attempt.current = null;
        onPaid({ id: requestId, movementId: result.movementId, total: result.totalUsd });
      } catch {
        setMessage('No se pudo confirmar la respuesta. Reintenta sin cambiar los datos para verificar el mismo pago.');
      } finally { submitting.current = false; }
    });
  }

  return <section aria-labelledby="delivery-payment-title" className="rounded-lg border border-[#FEEF00]/40 bg-[#16160F] p-3">
    <form action={submit}>
      <fieldset disabled={pending} className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><h2 id="delivery-payment-title" className="text-sm font-semibold">{partial ? 'Pagar selección' : 'Pagar período'} · {rows[0].responsible}</h2>
            <p className="mt-1 text-xs text-[#C2C2CA]">{from} al {to} · {rows.length} entregas · <strong className="text-white">{usd(total)}</strong></p></div>
          <button type="button" onClick={onClose} className={deliveryButton}>Cerrar</button>
        </div>
        <label className="grid max-w-md gap-1 text-xs">Forma de registro<select value={method} onChange={e => setMethod(e.target.value)} className={deliveryInput}>
          <option value="new">Registrar pago y egreso</option><option value="existing">Ya registré el egreso: relacionarlo con estas entregas</option></select></label>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-xs">Fecha del pago<input name="paymentDate" type="date" defaultValue={today} max={today} required className={deliveryInput} /></label>
          {method === 'existing' ? <label className="grid gap-1 text-xs">Número del egreso existente<input name="existingMovementId" type="number" min="1" step="1" required className={deliveryInput} /></label> : <>
            <label className="grid gap-1 text-xs">Cuenta de salida<select value={accountId} onChange={e => setAccountId(e.target.value)} required className={deliveryInput}><option value="">Seleccionar cuenta</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name} · {a.currency_code}</option>)}</select></label>
            {account?.currency_code === 'VES' ? <label className="grid gap-1 text-xs">Tasa del pago (Bs/USD)<input value={rate} onChange={e => setRate(e.target.value)} type="number" min="0.000001" step="any" required className={deliveryInput} /></label> : null}
            <label className="grid gap-1 text-xs">Importe · {account?.currency_code || 'USD'}<input key={`${accountId}-${rate}-${total}`} name="amount" type="number" min="0.01" max="1000000000" step="0.01" defaultValue={Number.isFinite(native) ? native.toFixed(2) : ''} required className={deliveryInput} /></label>
          </>}
          <label className="grid gap-1 text-xs">Referencia<input name="reference" maxLength={120} className={deliveryInput} /></label>
        </div>
        <details className="text-xs"><summary className="cursor-pointer py-1 text-[#B9B9C4]">Agregar nota</summary><input aria-label="Nota del pago" name="notes" maxLength={500} className={`${deliveryInput} mt-1 w-full`} /></details>
        {tariffCount > 0 ? <label className="flex min-h-9 items-start gap-2 text-xs"><input className="mt-0.5" name="confirmTariffs" type="checkbox" required /><span>{tariffCount} entregas no tenían costo guardado. Confirmo que el tabulador actual corresponde a este período; se guardarán estos importes al registrar el pago.</span></label> : null}
        <label className="flex min-h-9 items-center gap-2 text-xs"><input name="confirmedUnpaid" type="checkbox" required />Confirmo que estas entregas no tienen otro pago registrado.</label>
        {message ? <p role="alert" className="text-xs text-orange-200">{message}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button className={deliveryPrimaryButton}>{pending ? 'Registrando…' : `Confirmar pago · ${usd(total)}`}</button>
          <p className="max-w-xl text-xs text-[#B9B9C4]">{method === 'new' ? 'Guarda el egreso y lo relaciona con todas estas entregas. La transferencia o entrega de efectivo se hace fuera de la aplicación.' : 'Relaciona el egreso existente con estas entregas, sin crear otra salida de dinero.'}</p>
        </div>
      </fieldset>
    </form>
  </section>;
}
