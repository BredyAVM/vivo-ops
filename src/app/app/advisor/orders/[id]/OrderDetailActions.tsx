'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useMemo, useState, useTransition } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import { createAdvisorPaymentReportAction } from './actions';

const ADVISOR_DISPLAY_NAME_KEY = 'advisor_display_name_v1';

type MoneyAccountOption = {
  id: number;
  name: string;
  currencyCode: string;
  isActive: boolean;
  paymentMethodCodes?: string[];
};

function getSuggestedAccountAmount(
  usdAmount: number,
  currencyCode: string | null | undefined,
  activeBsRate: number,
) {
  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return '';

  if (currencyCode === 'VES' && Number.isFinite(activeBsRate) && activeBsRate > 0) {
    return String(Number((usdAmount * activeBsRate).toFixed(2)));
  }

  return String(Number(usdAmount.toFixed(2)));
}

function inputClass(multiline = false) {
  return [
    'w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 text-sm text-[#F5F7FB] placeholder:text-[#636C80]',
    multiline ? 'min-h-[88px] py-3' : 'h-11',
  ].join(' ');
}

function normalizeAdvisorLabel(value: string | null | undefined) {
  return String(value || '').trim() || 'Asesor';
}

function getPaymentMethodLabel(method: string) {
  const labels: Record<string, string> = {
    payment_mobile: 'Pago movil',
    transfer: 'Transferencia',
    zelle: 'Zelle',
  };

  return labels[method] || method;
}

function patchAdvisorLabelInSummary(summary: string, advisorLabel: string) {
  const nextLabel = normalizeAdvisorLabel(advisorLabel);

  return summary
    .replace(/\*Asesor:\*.*$/m, `*Asesor:* ${nextLabel}`)
    .replace(/✅ Asesor:.*$/m, `✅ Asesor: ${nextLabel}`);
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1.5 text-[12px] font-medium text-[#AAB2C5]">{label}</div>
      {children}
    </label>
  );
}

export default function OrderDetailActions({
  orderId,
  balanceUsd,
  canCorrectOrder,
  canDuplicateOrder,
  canReportPayment,
  paymentMethod,
  moneyAccounts,
  activeBsRate,
  whatsappSummary,
  whatsappContactHref,
  preferWhatsApp = false,
  initialReportBoxOpen = false,
}: {
  orderId: number;
  balanceUsd: number;
  canCorrectOrder: boolean;
  canDuplicateOrder: boolean;
  canReportPayment: boolean;
  paymentMethod: string | null;
  moneyAccounts: MoneyAccountOption[];
  activeBsRate: number;
  whatsappSummary: string;
  whatsappContactHref?: string;
  preferWhatsApp?: boolean;
  initialReportBoxOpen?: boolean;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isPending, startTransition] = useTransition();
  const [reportBoxOpen, setReportBoxOpen] = useState(initialReportBoxOpen && canReportPayment);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [advisorLabel, setAdvisorLabel] = useState('Asesor');
  const [moneyAccountId, setMoneyAccountId] = useState('');
  const [reportPaymentMethod, setReportPaymentMethod] = useState(
    paymentMethod && ['payment_mobile', 'transfer', 'zelle'].includes(paymentMethod) ? paymentMethod : '',
  );
  const [amount, setAmount] = useState(getSuggestedAccountAmount(balanceUsd, 'USD', activeBsRate));
  const [exchangeRate, setExchangeRate] = useState('');
  const [operationDate, setOperationDate] = useState(new Date().toISOString().slice(0, 10));
  const [referenceCode, setReferenceCode] = useState('');
  const [bankName, setBankName] = useState('');
  const [payerName, setPayerName] = useState('');
  const [notes, setNotes] = useState('');

  const activeAccounts = useMemo(
    () => moneyAccounts.filter((account) => account.isActive),
    [moneyAccounts],
  );
  const selectedAccount = useMemo(
    () => activeAccounts.find((account) => account.id === Number(moneyAccountId)) ?? null,
    [activeAccounts, moneyAccountId],
  );
  const orderLocksPaymentMethod = Boolean(paymentMethod && ['payment_mobile', 'transfer', 'zelle'].includes(paymentMethod));
  const availablePaymentMethods = selectedAccount?.paymentMethodCodes?.length ? selectedAccount.paymentMethodCodes : [];
  const paymentRequirements = getPaymentReportRequirements(reportPaymentMethod);
  const whatsappButtonClass = preferWhatsApp
    ? 'inline-flex h-9 items-center justify-center rounded-full bg-[#25D366] px-3.5 text-xs font-semibold text-[#07150C]'
    : 'inline-flex h-9 items-center justify-center rounded-full border border-[#232632] px-3.5 text-xs font-semibold text-[#25D366]';
  const effectiveWhatsappSummary = useMemo(
    () => patchAdvisorLabelInSummary(whatsappSummary, advisorLabel),
    [advisorLabel, whatsappSummary],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadAdvisorLabel() {
      if (typeof window !== 'undefined') {
        const stored = window.localStorage.getItem(ADVISOR_DISPLAY_NAME_KEY)?.trim();
        if (stored && !cancelled) {
          setAdvisorLabel(stored);
          return;
        }
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user || cancelled) return;

      const nextLabel = normalizeAdvisorLabel(
        user.user_metadata?.full_name ||
          user.user_metadata?.name ||
          'Asesor',
      );

      if (!cancelled) {
        setAdvisorLabel(nextLabel);
      }
    }

    void loadAdvisorLabel();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (!canCorrectOrder && !canDuplicateOrder && !canReportPayment && !whatsappSummary.trim()) return null;

  return (
    <div className="space-y-3">
      {(error || success) ? (
        <div
          className={[
            'rounded-[18px] border px-4 py-3 text-sm',
            error ? 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]' : 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]',
          ].join(' ')}
        >
          {error || success}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {whatsappContactHref ? (
          <a
            href={whatsappContactHref}
            target="_blank"
            rel="noreferrer"
            className={whatsappButtonClass}
          >
            WhatsApp
          </a>
        ) : null}

        <button
          type="button"
          onClick={async () => {
            setError(null);
            setSuccess(null);

            try {
              await navigator.clipboard.writeText(effectiveWhatsappSummary);
              setSuccess('Presupuesto copiado para WhatsApp.');
            } catch {
              setError('No se pudo copiar el presupuesto.');
            }
          }}
          className="inline-flex h-9 items-center justify-center rounded-full border border-[#232632] px-3.5 text-xs font-semibold text-[#F5F7FB]"
        >
          Copiar
        </button>

        {canCorrectOrder ? (
          <Link
            href={`/app/advisor/new?fromOrder=${orderId}`}
            className="inline-flex h-9 items-center justify-center rounded-full bg-[#F0D000] px-3.5 text-xs font-semibold text-[#17191E]"
          >
            Editar
          </Link>
        ) : null}

        {canDuplicateOrder ? (
          <Link
            href={`/app/advisor/new?duplicateFrom=${orderId}`}
            className="inline-flex h-9 items-center justify-center rounded-full border border-[#232632] px-3.5 text-xs font-semibold text-[#F5F7FB]"
          >
            Repetir
          </Link>
        ) : null}

        {canReportPayment ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSuccess(null);
              setOperationDate((current) => current || new Date().toISOString().slice(0, 10));
              setReportBoxOpen((current) => !current);
            }}
            className={[
              'inline-flex h-9 items-center justify-center rounded-full px-3.5 text-xs font-semibold',
              reportBoxOpen ? 'border border-[#F0D000] bg-[#201B08] text-[#F7DA66]' : 'border border-[#232632] text-[#F5F7FB]',
            ].join(' ')}
          >
            {reportBoxOpen ? 'Pago abierto' : 'Pago'}
          </button>
        ) : null}
      </div>

      {canReportPayment && reportBoxOpen ? (
        <div className="advisor-fade-in rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[#F5F7FB]">Reporte de pago</div>
              <div className="mt-1 text-xs leading-5 text-[#8B93A7]">
                Saldo pendiente: ${balanceUsd.toFixed(2)}. Se enviara a revision.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setReportBoxOpen(false)}
              className="inline-flex h-8 items-center rounded-full border border-[#232632] px-3 text-[11px] font-medium text-[#CCD3E2]"
            >
              Ocultar
            </button>
          </div>
          {selectedAccount?.currencyCode === 'VES' && activeBsRate > 0 ? (
            <div className="mt-2 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs text-[#8B93A7]">
              Sugerido en Bs:{' '}
              <span className="font-medium text-[#F5F7FB]">
                {getSuggestedAccountAmount(balanceUsd, 'VES', activeBsRate)}
              </span>{' '}
              | Tasa activa:{' '}
              <span className="font-medium text-[#F5F7FB]">{Number(activeBsRate.toFixed(2))}</span>
            </div>
          ) : null}

          <div className="mt-3 space-y-3">
            <Field label="Cuenta">
              <select
                value={moneyAccountId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setMoneyAccountId(nextId);
                  const account = activeAccounts.find((row) => row.id === Number(nextId)) ?? null;
                  const accountMethods = account?.paymentMethodCodes ?? [];
                  setAmount(getSuggestedAccountAmount(balanceUsd, account?.currencyCode, activeBsRate));
                  setExchangeRate(
                    account?.currencyCode === 'VES' && activeBsRate > 0
                      ? String(Number(activeBsRate.toFixed(2)))
                      : '',
                  );
                  if (orderLocksPaymentMethod) {
                    setReportPaymentMethod(paymentMethod || '');
                  } else if (!accountMethods.includes(reportPaymentMethod)) {
                    setReportPaymentMethod(accountMethods[0] ?? '');
                  }
                }}
                className={inputClass()}
              >
                <option value="">Selecciona una cuenta</option>
                {activeAccounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.currencyCode})
                    {account.paymentMethodCodes?.length
                      ? ` - ${account.paymentMethodCodes.map(getPaymentMethodLabel).join(' / ')}`
                      : ''}
                  </option>
                ))}
              </select>
            </Field>

            {selectedAccount && availablePaymentMethods.length > 0 ? (
              <Field label="Metodo">
                <select
                  value={reportPaymentMethod}
                  onChange={(e) => setReportPaymentMethod(e.target.value)}
                  className={inputClass()}
                  disabled={orderLocksPaymentMethod}
                >
                  <option value="">Selecciona metodo</option>
                  {availablePaymentMethods.map((method) => (
                    <option key={method} value={method}>
                      {getPaymentMethodLabel(method)}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field label="Monto reportado">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                className={inputClass()}
                inputMode="decimal"
                placeholder="0"
              />
            </Field>

            {selectedAccount?.currencyCode === 'VES' ? (
              <Field label="Tasa VES por USD">
                <input
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  className={inputClass()}
                  inputMode="decimal"
                  placeholder="Tasa"
                />
              </Field>
            ) : null}

            {paymentRequirements.requiresOperationDate ? (
              <Field label="Fecha de operacion">
                <input
                  value={operationDate}
                  onChange={(e) => setOperationDate(e.target.value)}
                  className={inputClass()}
                  type="date"
                />
              </Field>
            ) : null}

            <Field label="Referencia">
              <input
                value={referenceCode}
                onChange={(e) => setReferenceCode(e.target.value)}
                className={inputClass()}
                placeholder={paymentRequirements.requiresReference ? 'Numero de referencia' : 'Ultimos digitos o numero'}
              />
            </Field>

            {paymentRequirements.requiresBank ? (
              <Field label="Banco">
                <input
                  value={bankName}
                  onChange={(e) => setBankName(e.target.value)}
                  className={inputClass()}
                  placeholder="Banco de la operacion"
                />
              </Field>
            ) : null}

            {paymentRequirements.requiresHolderName || !paymentRequirements.requiresBank ? (
              <Field label={paymentRequirements.requiresHolderName ? 'Titular' : 'Pagador'}>
                <input
                  value={payerName}
                  onChange={(e) => setPayerName(e.target.value)}
                  className={inputClass()}
                  placeholder={paymentRequirements.requiresHolderName ? 'Nombre del titular' : 'Nombre de quien pago'}
                />
              </Field>
            ) : null}

            <Field label="Notas">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className={inputClass(true)}
                placeholder="Motivo o aclaratoria"
              />
            </Field>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => {
                  setError(null);
                  setSuccess(null);

                  startTransition(async () => {
                    try {
                      const validationError = validatePaymentReportDetails({
                        method: reportPaymentMethod,
                        operationDate,
                        referenceCode,
                        bankName,
                        holderName: payerName,
                      });

                      if (validationError) {
                        setError(validationError);
                        return;
                      }

                      await createAdvisorPaymentReportAction({
                        orderId,
                        reportedMoneyAccountId: Number(moneyAccountId || 0),
                        reportedCurrency: selectedAccount?.currencyCode || '',
                        reportedAmount: Number(amount || 0),
                        reportedExchangeRateVesPerUsd:
                          selectedAccount?.currencyCode === 'VES' ? Number(exchangeRate || 0) : null,
                        paymentMethod: reportPaymentMethod || null,
                        operationDate: operationDate.trim() || null,
                        referenceCode: referenceCode.trim() || null,
                        bankName: bankName.trim() || null,
                        payerName: payerName.trim() || null,
                        notes: notes.trim() || null,
                      });

                      setSuccess('Pago enviado a revision.');
                      setReportBoxOpen(false);
                      router.refresh();
                    } catch (submitError) {
                      setError(
                        submitError instanceof Error ? submitError.message : 'No se pudo reportar el pago.',
                      );
                    }
                  });
                }}
                className={[
                  'h-11 rounded-[16px] px-4 text-sm font-semibold',
                  isPending ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
                ].join(' ')}
              >
                {isPending ? 'Enviando...' : 'Enviar'}
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => setReportBoxOpen(false)}
                className="h-11 rounded-[16px] border border-[#232632] px-4 text-sm font-semibold text-[#F5F7FB]"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
