'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { getPaymentMethodLabel as getSharedPaymentMethodLabel } from '@/lib/orders/order-labels';
import { getPaymentReportRequirements, validatePaymentReportDetails } from '@/lib/payments/payment-report-rules';
import {
  cancelAdvisorOrderAction,
  createAdvisorPaymentReportAction,
  loadAdvisorPaymentOptionsAction,
  requestClientFundApplicationAction,
} from './actions';

const ADVISOR_DISPLAY_NAME_KEY = 'advisor_display_name_v1';
const ADVISOR_REPORT_PAYMENT_METHODS = ['payment_mobile', 'transfer', 'zelle', 'wallet_usd'];

type MoneyAccountOption = {
  id: number;
  name: string;
  currencyCode: string;
  isActive: boolean;
  paymentMethodCodes?: string[];
};

function getSuggestedAccountAmount(
  usdAmount: number,
  bsAmount: number,
  currencyCode: string | null | undefined,
  activeBsRate: number,
  useSnapshotQuote = true,
) {
  if (currencyCode === 'VES' && useSnapshotQuote && Number.isFinite(bsAmount) && bsAmount > 0) {
    return String(Number(bsAmount.toFixed(2)));
  }

  if (currencyCode === 'VES' && Number.isFinite(usdAmount) && usdAmount > 0 && Number.isFinite(activeBsRate) && activeBsRate > 0) {
    return String(Number((usdAmount * activeBsRate).toFixed(2)));
  }

  if (!Number.isFinite(usdAmount) || usdAmount <= 0) return '';

  return String(Number(usdAmount.toFixed(2)));
}

function getCaracasDateInputValue() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Caracas',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function normalizeDateOnly(value: string | null | undefined) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function operationDateIsAfterDeliveryDate(operationDate: string | null | undefined, deliveryReferenceDate: string | null | undefined) {
  const deliveryDate = normalizeDateOnly(deliveryReferenceDate);
  if (!deliveryDate) return false;

  const effectiveOperationDate = normalizeDateOnly(operationDate) ?? getCaracasDateInputValue();
  return effectiveOperationDate.localeCompare(deliveryDate) > 0;
}

function getPaymentCollectionMode(operationDate: string | null | undefined, deliveryReferenceDate: string | null | undefined) {
  if (operationDateIsAfterDeliveryDate(operationDate, deliveryReferenceDate)) {
    return {
      key: 'post_delivery_usd',
      label: 'Cobranza dolarizada',
      description: 'La fecha de operacion es posterior a la entrega: el saldo Bs se calcula con la tasa activa.',
    } as const;
  }

  return {
    key: 'snapshot_quote',
    label: 'Presupuesto snapshot',
    description: 'Se mantiene el monto Bs congelado del presupuesto.',
  } as const;
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
  return getSharedPaymentMethodLabel(method, { fallback: method });
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
  balanceBs,
  canCorrectOrder,
  canDuplicateOrder,
  canReportPayment,
  canRequestClientFund,
  canCancelOrder,
  clientFundAvailableUsd,
  fundRequestSuggestedUsd,
  hasPendingFundRequest,
  paymentMethod,
  moneyAccounts,
  activeBsRate,
  snapshotBsRate,
  deliveryReferenceDate,
  whatsappSummary,
  whatsappContactHref,
  preferWhatsApp = false,
  initialReportBoxOpen = false,
}: {
  orderId: number;
  balanceUsd: number;
  balanceBs: number;
  canCorrectOrder: boolean;
  canDuplicateOrder: boolean;
  canReportPayment: boolean;
  canRequestClientFund: boolean;
  canCancelOrder: boolean;
  clientFundAvailableUsd: number;
  fundRequestSuggestedUsd: number;
  hasPendingFundRequest: boolean;
  paymentMethod: string | null;
  moneyAccounts: MoneyAccountOption[];
  activeBsRate: number;
  snapshotBsRate: number;
  deliveryReferenceDate: string | null;
  whatsappSummary: string;
  whatsappContactHref?: string;
  preferWhatsApp?: boolean;
  initialReportBoxOpen?: boolean;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isPending, startTransition] = useTransition();
  const [fundRequestPending, startFundRequestTransition] = useTransition();
  const copySummaryRef = useRef(false);
  const fundRequestRef = useRef(false);
  const paymentReportRef = useRef(false);
  const canOpenPaymentTools = canReportPayment || canRequestClientFund;
  const [reportBoxOpen, setReportBoxOpen] = useState(initialReportBoxOpen && canOpenPaymentTools);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [copyingSummary, setCopyingSummary] = useState(false);
  const [sendingFundRequest, setSendingFundRequest] = useState(false);
  const [sendingPaymentReport, setSendingPaymentReport] = useState(false);
  const [cancelBoxOpen, setCancelBoxOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [sendingCancel, setSendingCancel] = useState(false);
  const [fundRequestSent, setFundRequestSent] = useState(hasPendingFundRequest);
  const [advisorLabel, setAdvisorLabel] = useState('Asesor');
  const [paymentAccounts, setPaymentAccounts] = useState<MoneyAccountOption[]>(moneyAccounts);
  const [paymentOptionsLoaded, setPaymentOptionsLoaded] = useState(moneyAccounts.length > 0);
  const [paymentOptionsLoading, setPaymentOptionsLoading] = useState(false);
  const [paymentOptionsError, setPaymentOptionsError] = useState<string | null>(null);
  const [moneyAccountId, setMoneyAccountId] = useState('');
  const [reportPaymentMethod, setReportPaymentMethod] = useState(
    paymentMethod && ADVISOR_REPORT_PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : '',
  );
  const [operationDate, setOperationDate] = useState(getCaracasDateInputValue());
  const [amount, setAmount] = useState(getSuggestedAccountAmount(balanceUsd, balanceBs, 'USD', activeBsRate));
  const [exchangeRate, setExchangeRate] = useState('');
  const [referenceCode, setReferenceCode] = useState('');
  const [bankName, setBankName] = useState('');
  const [payerName, setPayerName] = useState('');
  const [notes, setNotes] = useState('');
  const [fundRequestAmount, setFundRequestAmount] = useState(
    fundRequestSuggestedUsd > 0 ? String(Number(fundRequestSuggestedUsd.toFixed(2))) : '',
  );
  const [fundRequestNotes, setFundRequestNotes] = useState('');

  const activeAccounts = useMemo(
    () => paymentAccounts.filter((account) => account.isActive),
    [paymentAccounts],
  );
  const selectedAccount = useMemo(
    () => activeAccounts.find((account) => account.id === Number(moneyAccountId)) ?? null,
    [activeAccounts, moneyAccountId],
  );
  const orderLocksPaymentMethod = Boolean(paymentMethod && ADVISOR_REPORT_PAYMENT_METHODS.includes(paymentMethod));
  const availablePaymentMethods = selectedAccount?.paymentMethodCodes?.length ? selectedAccount.paymentMethodCodes : [];
  const paymentRequirements = getPaymentReportRequirements(reportPaymentMethod);
  const collectionMode = getPaymentCollectionMode(operationDate, deliveryReferenceDate);
  const useSnapshotQuote = collectionMode.key === 'snapshot_quote';
  const suggestedVesAmount = getSuggestedAccountAmount(balanceUsd, balanceBs, 'VES', activeBsRate, useSnapshotQuote);
  const getSuggestedPaymentAmount = useCallback(
    (currencyCode: string | null | undefined, nextOperationDate = operationDate) => {
      const nextMode = getPaymentCollectionMode(nextOperationDate, deliveryReferenceDate);
      return getSuggestedAccountAmount(
        balanceUsd,
        balanceBs,
        currencyCode,
        activeBsRate,
        nextMode.key === 'snapshot_quote',
      );
    },
    [activeBsRate, balanceBs, balanceUsd, deliveryReferenceDate, operationDate],
  );
  const getSuggestedPaymentExchangeRate = useCallback(
    (currencyCode: string | null | undefined, nextOperationDate = operationDate) => {
      if (currencyCode !== 'VES') return '';

      const nextMode = getPaymentCollectionMode(nextOperationDate, deliveryReferenceDate);
      if (nextMode.key === 'snapshot_quote' && snapshotBsRate > 0) {
        return String(Number(snapshotBsRate.toFixed(4)));
      }

      return activeBsRate > 0 ? String(Number(activeBsRate.toFixed(4))) : '';
    },
    [activeBsRate, deliveryReferenceDate, operationDate, snapshotBsRate],
  );
  const whatsappButtonClass = preferWhatsApp
    ? 'inline-flex h-9 items-center justify-center rounded-full bg-[#25D366] px-3.5 text-xs font-semibold text-[#07150C]'
    : 'inline-flex h-9 items-center justify-center rounded-full border border-[#232632] px-3.5 text-xs font-semibold text-[#25D366]';
  const effectiveWhatsappSummary = useMemo(
    () => patchAdvisorLabelInSummary(whatsappSummary, advisorLabel),
    [advisorLabel, whatsappSummary],
  );

  const loadPaymentOptions = useCallback(async (force = false) => {
    if (!canReportPayment || (!force && paymentOptionsLoaded) || paymentOptionsLoading) return;

    setPaymentOptionsLoading(true);
    setPaymentOptionsError(null);

    try {
      const result = await loadAdvisorPaymentOptionsAction({ orderId });
      setPaymentAccounts(result.moneyAccounts ?? []);
      setPaymentOptionsLoaded(true);
    } catch (loadError) {
      setPaymentOptionsError(
        loadError instanceof Error ? loadError.message : 'No se pudieron cargar las cuentas de pago.',
      );
    } finally {
      setPaymentOptionsLoading(false);
    }
  }, [canReportPayment, orderId, paymentOptionsLoaded, paymentOptionsLoading]);

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

  useEffect(() => {
    if (!reportBoxOpen || !canReportPayment) return;
    void loadPaymentOptions();
  }, [canReportPayment, loadPaymentOptions, reportBoxOpen]);

  useEffect(() => {
    if (!moneyAccountId) return;
    if (activeAccounts.some((account) => account.id === Number(moneyAccountId))) return;
    setMoneyAccountId('');
  }, [activeAccounts, moneyAccountId]);

  const fundRequestDisabled = fundRequestPending || sendingFundRequest || fundRequestSent || !canRequestClientFund;
  const paymentReportDisabled = isPending || sendingPaymentReport;
  const cancelOrderDisabled = isPending || sendingCancel || !canCancelOrder;

  async function handleCopySummary() {
    if (copySummaryRef.current) return;

    setError(null);
    setSuccess(null);
    copySummaryRef.current = true;
    setCopyingSummary(true);

    try {
      await navigator.clipboard.writeText(effectiveWhatsappSummary);
      setSuccess('Resumen copiado para WhatsApp.');
    } catch {
      setError('No se pudo copiar el resumen.');
    } finally {
      copySummaryRef.current = false;
      setCopyingSummary(false);
    }
  }

  if (!canCorrectOrder && !canDuplicateOrder && !canReportPayment && !canRequestClientFund && !canCancelOrder && !whatsappSummary.trim()) return null;

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
          onClick={() => void handleCopySummary()}
          disabled={copyingSummary}
          className={[
            'inline-flex h-9 items-center justify-center rounded-full border px-3.5 text-xs font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
            copyingSummary
              ? 'border-[#232632] bg-[#232632] text-[#6F7890]'
              : 'border-[#232632] text-[#F5F7FB]',
          ].join(' ')}
        >
          {copyingSummary ? 'Copiando...' : 'Copiar'}
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

        {canOpenPaymentTools ? (
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

        {canCancelOrder ? (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setSuccess(null);
              setCancelBoxOpen((current) => !current);
            }}
            className={[
              'inline-flex h-9 items-center justify-center rounded-full border px-3.5 text-xs font-semibold',
              cancelBoxOpen ? 'border-[#F0A6AE] bg-[#261114] text-[#F0A6AE]' : 'border-[#5E2229] text-[#F0A6AE]',
            ].join(' ')}
          >
            Cancelar orden
          </button>
        ) : null}
      </div>

      {canCancelOrder && cancelBoxOpen ? (
        <div className="advisor-fade-in rounded-[18px] border border-[#5E2229] bg-[#140D10] px-3.5 py-3">
          <div className="text-sm font-medium text-[#F5F7FB]">Cancelar orden</div>
          <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">
            Disponible solo antes de entrar a cocina. Si ya hay dinero reportado o confirmado, debe hacerlo master/admin.
          </div>

          <div className="mt-3">
            <Field label="Motivo de cancelacion">
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className={inputClass(true)}
                disabled={cancelOrderDisabled}
                placeholder="Cliente cancelo, error en la solicitud, cambio de fecha..."
              />
            </Field>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              aria-busy={sendingCancel}
              data-busy={sendingCancel ? 'true' : undefined}
              disabled={cancelOrderDisabled}
              onClick={() => {
                if (sendingCancel) return;

                setError(null);
                setSuccess(null);
                setSendingCancel(true);

                startTransition(async () => {
                  try {
                    const formData = new FormData();
                    formData.set('orderId', String(orderId));
                    formData.set('reason', cancelReason);

                    await cancelAdvisorOrderAction(formData);

                    setSuccess('Orden cancelada.');
                    setCancelBoxOpen(false);
                    router.refresh();
                  } catch (submitError) {
                    setError(
                      submitError instanceof Error ? submitError.message : 'No se pudo cancelar la orden.',
                    );
                  } finally {
                    setSendingCancel(false);
                  }
                });
              }}
              className={[
                'h-11 rounded-[16px] px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                cancelOrderDisabled ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#D92D3D] text-white',
              ].join(' ')}
            >
              {sendingCancel ? 'Cancelando...' : 'Confirmar cancelacion'}
            </button>
            <button
              type="button"
              disabled={cancelOrderDisabled}
              onClick={() => setCancelBoxOpen(false)}
              className="h-11 rounded-[16px] border border-[#232632] px-4 text-sm font-semibold text-[#F5F7FB] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:text-[#6F7890]"
            >
              Cerrar
            </button>
          </div>
        </div>
      ) : null}

      {canOpenPaymentTools && reportBoxOpen ? (
        <div className="advisor-fade-in rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-[#F5F7FB]">Opciones de pago</div>
              <div className="mt-1 text-xs leading-5 text-[#8B93A7]">
                Saldo pendiente: ${balanceUsd.toFixed(2)}
                {balanceBs > 0 ? ` / Bs ${balanceBs.toFixed(2)}` : ''}. Se enviara a revision.
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

          {clientFundAvailableUsd > 0.005 ? (
            <div className="mt-3 rounded-[16px] border border-emerald-500/25 bg-[#0D1712] px-3 py-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-[#F5F7FB]">Fondo disponible</div>
                  <div className="mt-1 text-xs leading-5 text-[#AAB2C5]">
                    El cliente tiene ${clientFundAvailableUsd.toFixed(2)}. Solicita a master/admin aplicarlo a esta orden.
                  </div>
                </div>
                <div className="shrink-0 rounded-full border border-emerald-500/30 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
                  ${clientFundAvailableUsd.toFixed(2)}
                </div>
              </div>

              {canRequestClientFund ? (
                <div className="mt-3 grid gap-2">
                  <Field label="Monto a solicitar (USD)">
                    <input
                      value={fundRequestAmount}
                      onChange={(e) => setFundRequestAmount(e.target.value)}
                      onFocus={(e) => e.currentTarget.select()}
                      className={inputClass()}
                      disabled={fundRequestDisabled}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </Field>

                  <Field label="Nota para master/admin">
                    <textarea
                      value={fundRequestNotes}
                      onChange={(e) => setFundRequestNotes(e.target.value)}
                      className={inputClass(true)}
                      disabled={fundRequestDisabled}
                      placeholder="Opcional"
                    />
                  </Field>

                  <button
                    type="button"
                    disabled={fundRequestDisabled}
                    onClick={() => {
                      if (fundRequestRef.current) return;

                      setError(null);
                      setSuccess(null);
                      fundRequestRef.current = true;
                      setSendingFundRequest(true);

                      startFundRequestTransition(async () => {
                        try {
                          const formData = new FormData();
                          formData.set('orderId', String(orderId));
                          formData.set('amountUsd', fundRequestAmount);
                          formData.set('notes', fundRequestNotes);

                          await requestClientFundApplicationAction(formData);

                          setFundRequestSent(true);
                          setSuccess('Solicitud de fondo enviada a master/admin.');
                          router.refresh();
                        } catch (submitError) {
                          setError(
                            submitError instanceof Error
                              ? submitError.message
                              : 'No se pudo solicitar aplicar el fondo.',
                          );
                        } finally {
                          fundRequestRef.current = false;
                          setSendingFundRequest(false);
                        }
                      });
                    }}
                    className={[
                      'h-10 rounded-[14px] px-3.5 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                      fundRequestDisabled
                        ? 'bg-[#232632] text-[#6F7890]'
                        : 'bg-[#F0D000] text-[#17191E]',
                    ].join(' ')}
                  >
                    {fundRequestPending || sendingFundRequest
                      ? 'Enviando...'
                      : fundRequestSent
                        ? 'Solicitud enviada'
                        : 'Solicitar aplicar fondo'}
                  </button>
                </div>
              ) : (
                <div className="mt-3 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs text-[#AAB2C5]">
                  {fundRequestSent
                    ? 'Ya hay una solicitud enviada para esta orden.'
                    : 'No hay saldo pendiente disponible para aplicar este fondo.'}
                </div>
              )}
            </div>
          ) : null}

          {canReportPayment && paymentOptionsLoading ? (
            <div className="mt-3 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs text-[#AAB2C5]">
              Cargando cuentas disponibles...
            </div>
          ) : null}

          {canReportPayment && paymentOptionsError ? (
            <div className="mt-3 rounded-[14px] border border-[#5E2229] bg-[#261114] px-3 py-2 text-xs leading-5 text-[#F0A6AE]">
              <div>{paymentOptionsError}</div>
              <button
                type="button"
                onClick={() => {
                  void loadPaymentOptions(true);
                }}
                className="mt-2 h-8 rounded-full border border-[#7A2E38] px-3 text-[11px] font-semibold text-[#F0A6AE]"
              >
                Reintentar
              </button>
            </div>
          ) : null}

          {canReportPayment && paymentOptionsLoaded && activeAccounts.length === 0 ? (
            <div className="mt-3 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs text-[#AAB2C5]">
              No hay cuentas disponibles para reportar este metodo de pago.
            </div>
          ) : null}

          {canReportPayment && selectedAccount?.currencyCode === 'VES' && activeBsRate > 0 ? (
            <div className="mt-2 rounded-[14px] border border-[#232632] bg-[#0B1017] px-3 py-2 text-xs text-[#8B93A7]">
              {collectionMode.label}:{' '}
              <span className="font-medium text-[#F5F7FB]">
                {suggestedVesAmount || '0'}
              </span>{' '}
              | {collectionMode.description}
            </div>
          ) : null}

          {canReportPayment && !paymentOptionsLoading && !paymentOptionsError && activeAccounts.length > 0 ? (
          <div className="mt-3 space-y-3">
            <Field label="Cuenta">
              <select
                value={moneyAccountId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setMoneyAccountId(nextId);
                  const account = activeAccounts.find((row) => row.id === Number(nextId)) ?? null;
                  const accountMethods = account?.paymentMethodCodes ?? [];
                  setAmount(getSuggestedPaymentAmount(account?.currencyCode));
                  setExchangeRate(getSuggestedPaymentExchangeRate(account?.currencyCode));
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

            {paymentRequirements.requiresOperationDate ? (
              <Field label="Fecha de operacion">
                <input
                  value={operationDate}
                  onChange={(e) => {
                    const nextOperationDate = e.target.value;
                    setOperationDate(nextOperationDate);

                    if (selectedAccount) {
                      setAmount(getSuggestedPaymentAmount(selectedAccount.currencyCode, nextOperationDate));
                      setExchangeRate(getSuggestedPaymentExchangeRate(selectedAccount.currencyCode, nextOperationDate));
                    }
                  }}
                  className={inputClass()}
                  type="date"
                />
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

            {selectedAccount?.currencyCode === 'VES' && useSnapshotQuote ? (
              <div className="rounded-[14px] border border-[#3A3212] bg-[#1D1A00] px-3 py-2 text-xs leading-5 text-[#FEEF00]">
                Usar monto Bs de la orden: {suggestedVesAmount || '0'}.
                <span className="block text-[#B7B7C2]">
                  La fecha de operacion no pasa la fecha de entrega, por eso no se modifica la tasa.
                </span>
              </div>
            ) : null}

            {selectedAccount?.currencyCode === 'VES' && !useSnapshotQuote ? (
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
                aria-busy={sendingPaymentReport}
                data-busy={sendingPaymentReport ? 'true' : undefined}
                disabled={paymentReportDisabled}
                onClick={() => {
                  if (paymentReportRef.current) return;

                  setError(null);
                  setSuccess(null);
                  paymentReportRef.current = true;
                  setSendingPaymentReport(true);

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
                    } finally {
                      paymentReportRef.current = false;
                      setSendingPaymentReport(false);
                    }
                  });
                }}
                className={[
                  'h-11 rounded-[16px] px-4 text-sm font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed',
                  paymentReportDisabled ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
                ].join(' ')}
              >
                {paymentReportDisabled ? 'Enviando...' : 'Enviar'}
              </button>
              <button
                type="button"
                disabled={paymentReportDisabled}
                onClick={() => setReportBoxOpen(false)}
                className="h-11 rounded-[16px] border border-[#232632] px-4 text-sm font-semibold text-[#F5F7FB] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:text-[#6F7890]"
              >
                Cerrar
              </button>
            </div>
          </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
