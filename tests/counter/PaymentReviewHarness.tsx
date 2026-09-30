'use client';
import { useState } from 'react';
// Mount locally for browser verification; all callbacks are simulated and never contact a database.
import { CounterPaymentEngine } from '../../src/app/app/counter/CounterPaymentEngine';
import type { CounterOrder, CounterPaymentAccountOption } from '../../src/app/app/counter/CounterClient';

const quote = { operationDate: '2026-09-30', pendingUsd: 26.8, pendingBs: 23000, exchangeRate: 857.01, snapshotRate: 857.01, collectionMode: 'snapshot_quote' as const };
const accounts = [
  { accountId: 1, accountName: 'Punto BDV 1', accountKind: 'pos', paymentMethodCode: 'pos', currencyCode: 'VES', canReportPayment: true, canConfirmPayment: true, autoConfirmsReport: true, reviewRequired: false },
  { accountId: 2, accountName: 'Caja DAR USD', accountKind: 'cash', paymentMethodCode: 'cash_usd', currencyCode: 'USD', canReportPayment: true, canConfirmPayment: true, autoConfirmsReport: true, reviewRequired: false },
  { accountId: 3, accountName: 'Caja DAR VES', accountKind: 'cash', paymentMethodCode: 'cash_ves', currencyCode: 'VES', canReportPayment: true, canConfirmPayment: true, autoConfirmsReport: true, reviewRequired: false },
  { accountId: 4, accountName: 'BDV Jurídico', accountKind: 'bank', paymentMethodCode: 'payment_mobile', currencyCode: 'VES', canReportPayment: true, canConfirmPayment: false, autoConfirmsReport: false, reviewRequired: true },
] as CounterPaymentAccountOption[];

export default function Preview() {
  const [version, setVersion] = useState(0);
  const [change, setChange] = useState(false);
  const [calls, setCalls] = useState<unknown[]>([]);
  const [fail, setFail] = useState(false);
  const order = { id: 900001, clientName: 'Cliente de prueba', paymentMethod: 'pos', changeAvailableUsd: change ? 4.83 : 0, paymentQuote: change ? { ...quote, pendingUsd: 0, pendingBs: 0 } : quote } as CounterOrder;
  return <main className="mx-auto max-w-2xl bg-[#0B0B0D] p-5 text-white">
    <h1>Prueba local · Sin conexión a caja real</h1>
    <div className="my-4 flex gap-4">
      <button onClick={() => {setChange(false); setVersion(version + 1); setCalls([]);}}>Reiniciar pago</button>
      <button onClick={() => {setChange(true); setVersion(version + 1); setCalls([]);}}>Probar cambio</button>
      <label><input type="checkbox" checked={fail} onChange={e => setFail(e.target.checked)} /> Simular error</label>
    </div>
    <CounterPaymentEngine key={version} order={order} paymentAccounts={accounts} isWorking={false}
      onLoadPaymentQuote={async () => quote} onFinish={() => {}}
      onSubmit={async intent => {
        setCalls(previous => [...previous, intent]);
        await new Promise(resolve => setTimeout(resolve, 350));
        if (fail) throw new Error('Error de prueba: reintenta sin duplicar.');
        const immediate = intent.paymentLines[0].paymentMethod !== 'payment_mobile';
        return { ok: true, idempotencyKey: intent.idempotencyKey, orderId: order.id, reportCount: 1, confirmedReportCount: immediate ? 1 : 0, pendingReportCount: immediate ? 0 : 1, confirmedPaymentUsd: immediate ? 26.8 : 0, pendingPaymentUsd: immediate ? 0 : 26.8, cashChangeUsd: 0, digitalChangePendingUsd: 0, fundCreditUsd: 0, pendingUsd: immediate ? 0 : 26.8, overpaidUsd: 0 };
      }}
      onGiveChange={async intent => {
        setCalls(previous => [...previous, intent]);
        return {ok: true, idempotencyKey: intent.idempotencyKey, orderId: order.id, movementId: 1, moneyAccountId: 2, accountName: 'Caja DAR USD', currencyCode: 'USD', amount: intent.amount, exchangeRateVesPerUsd: null, amountUsdEquivalent: intent.amount, fundBackedChangeUsd: 4.83, advanceChangeUsd: 0.17, remainingChangeUsd: 0, pendingUsd: 0.17};
      }} onWaiveChange={async () => {throw new Error('No se usa en esta prueba');}}
    />
    <pre data-testid="calls" className="mt-5 whitespace-pre-wrap">{JSON.stringify(calls)}</pre>
  </main>;
}
