'use client';

import { useRef, useState, useTransition, type RefObject } from 'react';
import { deliveryServiceTotals, type DeliveryService } from '@/lib/admin-finance/delivery-services';
import { extraTotal, type DeliveryExtra } from '@/lib/admin-finance/delivery-extras';
import { deliveryDeductionPlan, type DeliveryDebt } from '@/lib/admin-finance/delivery-debts';
import { formatOrderDisplayNumber } from '@/lib/orders/order-labels';
import { recordDeliveryPayment, type DeliveryPaymentInput } from './actions';

export type DeliveryPaymentAttempt = { id: string; payload: string } | null;
export type DeliveryMoneyAccount = { id: number; name: string; currency_code: string };
export const deliveryInput = 'min-h-11 min-w-0 rounded-md border border-[#30303D] bg-[#14141C] px-2 text-xs text-white md:min-h-8 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-[#FEEF00]';
export const deliveryButton = `${deliveryInput} hover:bg-[#22222C]`;
export const deliveryPrimaryButton = 'min-h-11 rounded-md bg-[#FEEF00] px-3 text-xs font-semibold text-black hover:bg-yellow-200 md:min-h-8 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-white';
const usd = (n: number) => `$${n.toFixed(2)}`;

export default function DeliveryPaymentForm({ rows, extras, debts, accounts, from, to, today, partial, attempt, onClose, onPaid }: {
  debts: DeliveryDebt[];
  extras: DeliveryExtra[];
  rows: DeliveryService[]; accounts: DeliveryMoneyAccount[]; from: string; to: string; today: string; partial: boolean;
  attempt: RefObject<DeliveryPaymentAttempt>;
  onClose: () => void; onPaid: (receipt: { id: string; movementId: number | null; total: number }) => void;
}) {
  const [accountId, setAccountId] = useState('');
  const [rate, setRate] = useState('');
  const [method, setMethod] = useState('new');
  const [message, setMessage] = useState('');
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const submitting = useRef(false);
  const orderTotal = deliveryServiceTotals(rows).amount;
  const extrasTotal = extraTotal(extras);
  const gross = (Math.round(orderTotal * 100) + Math.round(extrasTotal * 100)) / 100;
  const plan = deliveryDeductionPlan(debts, chosen, gross);
  const total = plan.net;
  const tariffCount = rows.filter(row => row.cost.stored === null).length;
  const account = accounts.find(row => String(row.id) === accountId);
  const native = account?.currency_code === 'VES' ? total * Number(rate || 0) : total;

  function submit(form: FormData) {
    if (submitting.current || plan.error) return;
    const input: DeliveryPaymentInput = {
      from, to, paymentDate: String(form.get('paymentDate')),
      items: rows.map(row => ({ id: row.id, fingerprint: row.cost.fingerprint })),
      extras: extras.map(row => ({ id: row.id, fingerprint: row.fingerprint })),
      deductions: plan.deductions,
      accountId: total > 0 && method === 'new' ? Number(accountId) : null,
      amount: total > 0 && method === 'new' ? Number(form.get('amount')) : null,
      rate: total > 0 && method === 'new' && account?.currency_code === 'VES' ? Number(rate) : null,
      existingMovementId: total > 0 && method === 'existing' ? Number(form.get('existingMovementId')) : null,
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
          <div><h2 id="delivery-payment-title" className="text-sm font-semibold">{partial ? 'Pagar selección' : 'Pagar período'} · {rows[0]?.responsible ?? extras[0]?.responsible}</h2>
            <p className="mt-1 text-xs text-[#C2C2CA]">{from} al {to} · {rows.length} entregas: {usd(orderTotal)}{extras.length ? ` + ${extras.length} servicios adicionales: ${usd(extrasTotal)}` : ''} · Ganado: <strong className="text-white">{usd(gross)}</strong></p></div>
          <button type="button" onClick={onClose} className={deliveryButton}>Cerrar</button>
        </div>
        {debts.length ? <div className="rounded-md border border-[#383830] p-2">
          <h3 className="text-xs font-semibold">Descontar esta semana</h3>
          <p className="mt-1 text-[11px] text-[#B9B9C4]">Elige un importe por deuda. Dejar en cero no descuenta; el saldo restante continúa pendiente.</p>
          <div className="mt-2 max-h-60 space-y-2 overflow-auto">{debts.map(d => <label key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-xs"><span className="min-w-0 flex-1">{d.concept}{d.orderId ? ` · #${formatOrderDisplayNumber(d.orderId)}` : ''}<span className="block text-[11px] text-[#B9B9C4]">Deuda: {usd(d.balance)}</span></span>
            <input aria-label={`Descontar de ${d.concept}`} type="number" min="0" max={d.balance} step="0.01" value={chosen[d.id] ?? '0'} onChange={e => setChosen({ ...chosen, [d.id]: e.target.value })} className={`${deliveryInput} w-28 text-right`} /></label>)}</div>
          <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-[#383830] pt-2 text-xs"><div><dt>Descuento</dt><dd className="font-semibold">{usd(plan.discount)}</dd></div><div><dt>Pago neto</dt><dd className="font-semibold text-[#FEEF00]">{usd(total)}</dd></div><div><dt>Deuda restante</dt><dd className="font-semibold">{usd(plan.remaining)}</dd></div></dl>
          {plan.error ? <p role="alert" className="mt-2 text-xs text-orange-200">{plan.error}</p> : null}
        </div> : null}
        {total > 0 ? <label className="grid max-w-md gap-1 text-xs">Forma de registro<select value={method} onChange={e => setMethod(e.target.value)} className={deliveryInput}>
          <option value="new">Registrar pago y egreso</option><option value="existing">Ya registré el egreso: relacionarlo con estas entregas</option></select></label> : <p className="text-xs text-amber-100">Todo lo ganado se aplicará a las deudas elegidas. No se creará un egreso ni se moverá dinero de una cuenta.</p>}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <label className="grid gap-1 text-xs">Fecha del pago<input name="paymentDate" type="date" defaultValue={today} max={today} required className={deliveryInput} /></label>
          {total <= 0 ? null : method === 'existing' ? <label className="grid gap-1 text-xs">Número del egreso existente<input name="existingMovementId" type="number" min="1" step="1" required className={deliveryInput} /></label> : <>
            <label className="grid gap-1 text-xs">Cuenta de salida<select value={accountId} onChange={e => setAccountId(e.target.value)} required className={deliveryInput}><option value="">Seleccionar cuenta</option>{accounts.map(a => <option value={a.id} key={a.id}>{a.name} · {a.currency_code}</option>)}</select></label>
            {account?.currency_code === 'VES' ? <label className="grid gap-1 text-xs">Tasa del pago (Bs/USD)<input value={rate} onChange={e => setRate(e.target.value)} type="number" min="0.000001" step="any" required className={deliveryInput} /></label> : null}
            <label className="grid gap-1 text-xs">Importe · {account?.currency_code || 'USD'}<input key={`${accountId}-${rate}-${total}`} name="amount" type="number" min="0.01" max="1000000000" step="0.01" defaultValue={Number.isFinite(native) ? native.toFixed(2) : ''} required className={deliveryInput} /></label>
          </>}
          <label className="grid gap-1 text-xs">Referencia<input name="reference" maxLength={120} className={deliveryInput} /></label>
        </div>
        <details className="text-xs"><summary className="cursor-pointer py-1 text-[#B9B9C4]">Agregar nota</summary><input aria-label="Nota del pago" name="notes" maxLength={500} className={`${deliveryInput} mt-1 w-full`} /></details>
        {tariffCount > 0 ? <label className="flex min-h-9 items-start gap-2 text-xs"><input className="mt-0.5" name="confirmTariffs" type="checkbox" required /><span>{tariffCount} entregas no tenían costo guardado. Confirmo que el tabulador actual corresponde a este período; se guardarán estos importes al registrar el pago.</span></label> : null}
        <label className="flex min-h-9 items-center gap-2 text-xs"><input name="confirmedUnpaid" type="checkbox" required />Confirmo que estas entregas y servicios no tienen otro pago registrado.</label>
        {message ? <p role="alert" className="text-xs text-orange-200">{message}</p> : null}
        <div className="flex flex-wrap items-center gap-3">
          <button disabled={!!plan.error} className={deliveryPrimaryButton}>{pending ? 'Registrando…' : total === 0 ? 'Confirmar liquidación · $0.00' : `Confirmar pago neto · ${usd(total)}`}</button>
          <p className="max-w-xl text-xs text-[#B9B9C4]">{total === 0 ? 'Guarda la liquidación y sus descuentos, sin egreso.' : method === 'new' ? 'Guarda solamente el egreso neto y lo relaciona con estas entregas y descuentos. La transferencia o entrega de efectivo se hace fuera de la aplicación.' : 'El egreso existente debe coincidir con el pago neto, después de descuentos.'}</p>
        </div>
      </fieldset>
    </form>
  </section>;
}
