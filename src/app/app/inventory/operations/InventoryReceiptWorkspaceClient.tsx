'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  cancelInventoryExpectedReceiptAction,
  receiveInventoryStockAction,
  saveInventoryExpectedReceiptAction,
} from '../actions';

export type ReceiptCaptureDetails = {
  quantity_unknown?: boolean;
  source_name?: string | null;
  loose_units?: number;
  total_units?: number | null;
  presentations?: Array<{
    presentation_id: number;
    presentation_name: string;
    quantity: number;
    base_units_per_presentation: number;
    default_base_units_per_presentation?: number;
    base_units: number;
  }>;
};

export type ReceiptWorkspaceItem = {
  id: number;
  name: string;
  unit_name: string;
  inventory_group: string;
  current_stock_units: number;
  shelf_life_days: number | null;
  initialized: boolean;
};

export type ReceiptWorkspacePresentation = {
  id: number;
  inventory_item_id: number;
  name: string;
  base_units_per_presentation: number;
  allows_fractional_quantity: boolean;
};

export type ExpectedReceipt = {
  id: number;
  inventory_item_id: number;
  item_name: string;
  unit_name: string;
  quantity_units: number | null;
  effective_at: string;
  status: string;
  notes: string | null;
  capture_details: ReceiptCaptureDetails;
  created_at: string;
  is_overdue: boolean;
};

export type RecentReceipt = {
  lot_id: number;
  inventory_item_id: number;
  item_name: string;
  unit_name: string;
  received_quantity_units: number;
  received_at: string;
  expires_at: string | null;
  lot_code: string | null;
  notes: string | null;
  capture_details: ReceiptCaptureDetails;
  expected_flow_id: number | null;
  expected_quantity_units: number | null;
  expected_status: string | null;
  difference_quantity_units: number | null;
};

export type InventoryReceiptWorkspace = {
  permissions: {
    can_plan: boolean;
    can_receive: boolean;
  };
  items: ReceiptWorkspaceItem[];
  presentations: ReceiptWorkspacePresentation[];
  active_expectations: ExpectedReceipt[];
  recent_receipts: RecentReceipt[];
  summary: {
    active_expectations: number;
    overdue_expectations: number;
    receipt_mismatches: number;
  };
};

type CaptureLineDraft = {
  key: string;
  presentationId: string;
  quantity: string;
  factor: string;
};

type CaptureDraft = {
  quantityUnknown: boolean;
  sourceName: string;
  looseUnits: string;
  lines: CaptureLineDraft[];
};

const inputClass =
  'w-full rounded-lg border border-[#343444] bg-[#0D0D12] px-3 py-2 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';

function emptyCapture(): CaptureDraft {
  return {
    quantityUnknown: false,
    sourceName: '',
    looseUnits: '',
    lines: [],
  };
}

function lineKey() {
  return typeof crypto === 'undefined' ? String(Date.now()) : crypto.randomUUID();
}

function numericInput(value: string) {
  const normalized = value.trim().replace(',', '.');
  return normalized ? Number(normalized) : 0;
}

function formatQuantity(value: number | null, maximumFractionDigits = 3) {
  if (value == null || !Number.isFinite(Number(value))) return 'por confirmar';
  return new Intl.NumberFormat('es-VE', { maximumFractionDigits }).format(Number(value));
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('es-VE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Caracas',
  }).format(new Date(value));
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function captureFromDetails(details: ReceiptCaptureDetails): CaptureDraft {
  return {
    quantityUnknown: details.quantity_unknown === true,
    sourceName: details.source_name ?? '',
    looseUnits: details.loose_units ? String(details.loose_units) : '',
    lines: (details.presentations ?? []).map((line) => ({
      key: lineKey(),
      presentationId: String(line.presentation_id),
      quantity: String(line.quantity),
      factor: String(line.base_units_per_presentation),
    })),
  };
}

function capturePayload(capture: CaptureDraft) {
  return {
    quantityUnknown: capture.quantityUnknown,
    sourceName: capture.sourceName,
    looseUnits: capture.quantityUnknown ? 0 : numericInput(capture.looseUnits),
    presentations: capture.quantityUnknown
      ? []
      : capture.lines.map((line) => ({
          presentationId: Number(line.presentationId),
          quantity: numericInput(line.quantity),
          baseUnitsPerPresentation: numericInput(line.factor),
        })),
  };
}

export default function InventoryReceiptWorkspaceClient({
  workspace,
}: {
  workspace: InventoryReceiptWorkspace;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [expectedItemId, setExpectedItemId] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [expectedCapture, setExpectedCapture] = useState<CaptureDraft>(emptyCapture);
  const [expectedNotes, setExpectedNotes] = useState('');
  const [replacesFlowId, setReplacesFlowId] = useState<number | null>(null);

  const [receiptExpectationId, setReceiptExpectationId] = useState('');
  const [receiptItemId, setReceiptItemId] = useState('');
  const [receiptCapture, setReceiptCapture] = useState<CaptureDraft>(emptyCapture);
  const [lotCode, setLotCode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [receiptNotes, setReceiptNotes] = useState('');

  const items = useMemo(() => workspace.items ?? [], [workspace.items]);
  const presentations = useMemo(
    () => workspace.presentations ?? [],
    [workspace.presentations],
  );
  const expectations = useMemo(
    () => workspace.active_expectations ?? [],
    [workspace.active_expectations],
  );
  const recentReceipts = useMemo(
    () => workspace.recent_receipts ?? [],
    [workspace.recent_receipts],
  );
  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );
  const expectationById = useMemo(
    () => new Map(expectations.map((expectation) => [expectation.id, expectation])),
    [expectations],
  );
  const selectedReceiptItem = itemById.get(Number(receiptItemId));

  function resetExpectedForm() {
    setExpectedItemId('');
    setExpectedAt('');
    setExpectedCapture(emptyCapture());
    setExpectedNotes('');
    setReplacesFlowId(null);
  }

  function submitExpectation() {
    setError(null);
    setMessage(null);
    if (!expectedItemId || !expectedAt) {
      setError('Selecciona el ítem y la fecha esperada.');
      return;
    }

    startTransition(async () => {
      try {
        const result = await saveInventoryExpectedReceiptAction({
          operationId: crypto.randomUUID(),
          inventoryItemId: Number(expectedItemId),
          effectiveAt: new Date(expectedAt).toISOString(),
          capture: capturePayload(expectedCapture),
          notes: expectedNotes,
          replacesFlowId,
        });
        setMessage(
          replacesFlowId
            ? `La expectativa #${replacesFlowId} fue reemplazada por la #${result.expectedFlowId}.`
            : `Expectativa #${result.expectedFlowId} registrada sin aumentar el inventario.`,
        );
        resetExpectedForm();
        router.refresh();
      } catch (submissionError) {
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : 'No se pudo guardar la expectativa.',
        );
      }
    });
  }

  function prepareReplacement(expectation: ExpectedReceipt) {
    setExpectedItemId(String(expectation.inventory_item_id));
    setExpectedAt(toDateTimeLocal(expectation.effective_at));
    setExpectedCapture(captureFromDetails(expectation.capture_details ?? {}));
    setExpectedNotes(expectation.notes ?? '');
    setReplacesFlowId(expectation.id);
    setError(null);
    setMessage(`Editando mediante reemplazo trazable de la expectativa #${expectation.id}.`);
  }

  function cancelExpectation(expectation: ExpectedReceipt) {
    if (!window.confirm(`¿Cancelar la expectativa #${expectation.id} de ${expectation.item_name}?`)) {
      return;
    }
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        await cancelInventoryExpectedReceiptAction({ expectedFlowId: expectation.id });
        setMessage(`Expectativa #${expectation.id} cancelada.`);
        router.refresh();
      } catch (cancellationError) {
        setError(
          cancellationError instanceof Error
            ? cancellationError.message
            : 'No se pudo cancelar la expectativa.',
        );
      }
    });
  }

  function selectReceiptExpectation(value: string) {
    setReceiptExpectationId(value);
    const expectation = expectationById.get(Number(value));
    if (expectation) {
      setReceiptItemId(String(expectation.inventory_item_id));
      setReceiptCapture({
        ...emptyCapture(),
        sourceName: expectation.capture_details?.source_name ?? '',
      });
    } else {
      setReceiptItemId('');
      setReceiptCapture(emptyCapture());
    }
  }

  function submitReceipt() {
    setError(null);
    setMessage(null);
    if (!receiptItemId) {
      setError('Selecciona la expectativa o el ítem recibido.');
      return;
    }
    if (!selectedReceiptItem?.initialized) {
      setError('El ítem requiere una apertura aceptada antes de registrar entradas reales.');
      return;
    }

    startTransition(async () => {
      try {
        const result = await receiveInventoryStockAction({
          operationId: crypto.randomUUID(),
          inventoryItemId: Number(receiptItemId),
          expectedFlowId: receiptExpectationId ? Number(receiptExpectationId) : null,
          capture: capturePayload(receiptCapture),
          lotCode,
          expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
          notes: receiptNotes,
        });
        const difference = result.differenceQuantityUnits;
        setMessage(
          difference == null
            ? `Recepción #${result.inventoryLotId}: ingresaron ${formatQuantity(result.receivedQuantityUnits)} unidades.`
            : difference === 0
              ? `Recepción #${result.inventoryLotId} conciliada exactamente.`
              : `Recepción #${result.inventoryLotId}: diferencia de ${formatQuantity(difference)} frente a lo esperado; la expectativa quedó cerrada.`,
        );
        setReceiptExpectationId('');
        setReceiptItemId('');
        setReceiptCapture(emptyCapture());
        setLotCode('');
        setExpiresAt('');
        setReceiptNotes('');
        router.refresh();
      } catch (submissionError) {
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : 'No se pudo registrar la mercancía recibida.',
        );
      }
    });
  }

  return (
    <section className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="Esperadas activas" value={workspace.summary?.active_expectations ?? 0} />
        <SummaryCard label="Esperadas vencidas" value={workspace.summary?.overdue_expectations ?? 0} tone="warn" />
        <SummaryCard label="Diferencias históricas" value={workspace.summary?.receipt_mismatches ?? 0} tone="danger" />
        <SummaryCard label="Recepciones visibles" value={recentReceipts.length} tone="good" />
      </div>

      {error ? (
        <div role="alert" className="rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {message ? (
        <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-2">
        {workspace.permissions?.can_plan ? (
          <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">Recepción esperada</h3>
                <p className="mt-1 text-sm leading-6 text-[#92929F]">
                  Master proyecta fecha y cantidad. Esta acción no aumenta existencias.
                </p>
              </div>
              {replacesFlowId ? (
                <span className="rounded-full border border-amber-400/30 px-2.5 py-1 text-xs text-amber-200">
                  Reemplaza #{replacesFlowId}
                </span>
              ) : null}
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Ítem</span>
                <select value={expectedItemId} onChange={(event) => setExpectedItemId(event.target.value)} disabled={isPending || replacesFlowId != null} className={inputClass}>
                  <option value="">Seleccionar…</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Disponible a partir de</span>
                <input type="datetime-local" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} disabled={isPending} className={inputClass} />
              </label>
            </div>

            <CaptureEditor
              itemId={Number(expectedItemId) || null}
              item={itemById.get(Number(expectedItemId))}
              presentations={presentations}
              capture={expectedCapture}
              onChange={setExpectedCapture}
              allowUnknown
              disabled={isPending}
            />

            <label className="mt-4 block text-xs text-[#A6A6B2]">
              <span className="mb-1.5 block">Nota opcional</span>
              <textarea value={expectedNotes} onChange={(event) => setExpectedNotes(event.target.value)} maxLength={1000} disabled={isPending} className={`${inputClass} min-h-20`} />
            </label>

            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={submitExpectation} disabled={isPending} className="rounded-lg bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black disabled:opacity-50">
                {isPending ? 'Guardando…' : replacesFlowId ? 'Reemplazar expectativa' : 'Guardar expectativa'}
              </button>
              {replacesFlowId ? (
                <button type="button" onClick={resetExpectedForm} disabled={isPending} className="rounded-lg border border-[#383847] px-4 py-2 text-sm text-[#C4C4CE]">
                  Cancelar edición
                </button>
              ) : null}
            </div>
          </article>
        ) : null}

        {workspace.permissions?.can_receive ? (
          <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
            <h3 className="font-semibold">Mercancía realmente recibida</h3>
            <p className="mt-1 text-sm leading-6 text-[#92929F]">
              La cantidad se captura desde cero. Al asociarla, cierra completamente la expectativa.
            </p>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Expectativa</span>
                <select value={receiptExpectationId} onChange={(event) => selectReceiptExpectation(event.target.value)} disabled={isPending} className={inputClass}>
                  <option value="">Recepción no planificada</option>
                  {expectations.map((expectation) => (
                    <option key={expectation.id} value={expectation.id}>
                      #{expectation.id} · {expectation.item_name} · {formatDate(expectation.effective_at)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Ítem recibido</span>
                <select value={receiptItemId} onChange={(event) => { setReceiptItemId(event.target.value); setReceiptCapture(emptyCapture()); }} disabled={isPending || Boolean(receiptExpectationId)} className={inputClass}>
                  <option value="">Seleccionar…</option>
                  {items.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
            </div>

            {selectedReceiptItem && !selectedReceiptItem.initialized ? (
              <div className="mt-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-3 py-2 text-xs text-amber-100">
                Este ítem todavía no tiene una apertura aceptada. La entrada física permanecerá deshabilitada.
              </div>
            ) : null}

            <CaptureEditor
              itemId={Number(receiptItemId) || null}
              item={selectedReceiptItem}
              presentations={presentations}
              capture={receiptCapture}
              onChange={setReceiptCapture}
              allowUnknown={false}
              disabled={isPending}
            />

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Código de lote opcional</span>
                <input value={lotCode} onChange={(event) => setLotCode(event.target.value)} maxLength={120} disabled={isPending} className={inputClass} />
              </label>
              <label className="text-xs text-[#A6A6B2]">
                <span className="mb-1.5 block">Vencimiento opcional</span>
                <input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} disabled={isPending} className={inputClass} />
              </label>
            </div>
            <label className="mt-4 block text-xs text-[#A6A6B2]">
              <span className="mb-1.5 block">Nota opcional</span>
              <textarea value={receiptNotes} onChange={(event) => setReceiptNotes(event.target.value)} maxLength={1000} disabled={isPending} className={`${inputClass} min-h-20`} />
            </label>
            <button type="button" onClick={submitReceipt} disabled={isPending || !selectedReceiptItem?.initialized} className="mt-4 rounded-lg bg-[#FEEF00] px-4 py-2 text-sm font-bold text-black disabled:opacity-40">
              {isPending ? 'Registrando…' : 'Registrar entrada real'}
            </button>
          </article>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
          <h3 className="font-semibold">Expectativas pendientes</h3>
          <div className="mt-4 space-y-3">
            {expectations.length ? expectations.map((expectation) => (
              <div key={expectation.id} className="rounded-xl border border-[#292938] bg-[#15151D] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">#{expectation.id} · {expectation.item_name}</div>
                    <div className="mt-1 text-xs text-[#92929F]">
                      {formatDate(expectation.effective_at)} · {formatQuantity(expectation.quantity_units)} {expectation.unit_name}
                    </div>
                  </div>
                  <span className={`rounded-full border px-2.5 py-1 text-xs ${expectation.is_overdue ? 'border-red-400/30 text-red-200' : 'border-sky-400/30 text-sky-200'}`}>
                    {expectation.is_overdue ? 'Vencida' : 'Programada'}
                  </span>
                </div>
                {expectation.capture_details?.source_name ? (
                  <div className="mt-2 text-xs text-[#A6A6B2]">Fuente: {expectation.capture_details.source_name}</div>
                ) : null}
                {workspace.permissions?.can_plan ? (
                  <div className="mt-3 flex gap-2">
                    <button type="button" onClick={() => prepareReplacement(expectation)} disabled={isPending} className="rounded-lg border border-[#3A3A48] px-3 py-1.5 text-xs text-[#D0D0D8]">Reprogramar</button>
                    <button type="button" onClick={() => cancelExpectation(expectation)} disabled={isPending} className="rounded-lg border border-red-400/25 px-3 py-1.5 text-xs text-red-200">Cancelar</button>
                  </div>
                ) : null}
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">No hay recepciones esperadas activas.</div>
            )}
          </div>
        </article>

        <article className="rounded-2xl border border-[#292938] bg-[#111117] p-5">
          <h3 className="font-semibold">Recepciones recientes</h3>
          <div className="mt-4 space-y-3">
            {recentReceipts.length ? recentReceipts.slice(0, 20).map((receipt) => (
              <div key={receipt.lot_id} className="rounded-xl border border-[#292938] bg-[#15151D] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">Lote #{receipt.lot_id} · {receipt.item_name}</div>
                    <div className="mt-1 text-xs text-[#92929F]">
                      {formatDate(receipt.received_at)} · {formatQuantity(receipt.received_quantity_units)} {receipt.unit_name}
                    </div>
                  </div>
                  <ReceiptDifferenceBadge receipt={receipt} />
                </div>
                {receipt.expected_flow_id ? (
                  <div className="mt-2 text-xs text-[#A6A6B2]">Conciliada con expectativa #{receipt.expected_flow_id}</div>
                ) : (
                  <div className="mt-2 text-xs text-[#A6A6B2]">Recepción no planificada</div>
                )}
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">Todavía no existen entradas canónicas.</div>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

function CaptureEditor({
  itemId,
  item,
  presentations,
  capture,
  onChange,
  allowUnknown,
  disabled,
}: {
  itemId: number | null;
  item?: ReceiptWorkspaceItem;
  presentations: ReceiptWorkspacePresentation[];
  capture: CaptureDraft;
  onChange: (capture: CaptureDraft) => void;
  allowUnknown: boolean;
  disabled: boolean;
}) {
  const available = presentations.filter((presentation) => presentation.inventory_item_id === itemId);
  const selectedIds = new Set(capture.lines.map((line) => Number(line.presentationId)));
  const total = capture.quantityUnknown
    ? null
    : capture.lines.reduce(
        (sum, line) => sum + numericInput(line.quantity) * numericInput(line.factor),
        numericInput(capture.looseUnits),
      );

  function addLine() {
    const next = available.find((presentation) => !selectedIds.has(presentation.id));
    if (!next) return;
    onChange({
      ...capture,
      lines: [...capture.lines, {
        key: lineKey(),
        presentationId: String(next.id),
        quantity: '',
        factor: String(next.base_units_per_presentation),
      }],
    });
  }

  function updateLine(key: string, update: Partial<CaptureLineDraft>) {
    onChange({
      ...capture,
      lines: capture.lines.map((line) => line.key === key ? { ...line, ...update } : line),
    });
  }

  return (
    <div className="mt-4 rounded-xl border border-[#292938] bg-[#14141C] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-[#A6A6B2]">
          <span className="mb-1.5 block">Fuente o proveedor opcional</span>
          <input value={capture.sourceName} onChange={(event) => onChange({ ...capture, sourceName: event.target.value })} maxLength={160} disabled={disabled} className={inputClass} />
        </label>
        {!capture.quantityUnknown ? (
          <label className="text-xs text-[#A6A6B2]">
            <span className="mb-1.5 block">Unidades sueltas ({item?.unit_name ?? 'unidad base'})</span>
            <input value={capture.looseUnits} onChange={(event) => onChange({ ...capture, looseUnits: event.target.value })} inputMode="decimal" disabled={disabled} className={inputClass} />
          </label>
        ) : null}
      </div>

      {allowUnknown ? (
        <label className="mt-3 flex items-center gap-2 text-xs text-[#C4C4CE]">
          <input type="checkbox" checked={capture.quantityUnknown} onChange={(event) => onChange({ ...capture, quantityUnknown: event.target.checked, looseUnits: '', lines: [] })} disabled={disabled} />
          Cantidad todavía desconocida; no suma disponibilidad futura
        </label>
      ) : null}

      {!capture.quantityUnknown ? (
        <>
          <div className="mt-4 space-y-3">
            {capture.lines.map((line) => {
              const selected = available.find((presentation) => presentation.id === Number(line.presentationId));
              return (
                <div key={line.key} className="grid gap-2 rounded-lg border border-[#2D2D3B] p-3 sm:grid-cols-[1fr_110px_130px_auto] sm:items-end">
                  <label className="text-xs text-[#A6A6B2]">
                    <span className="mb-1 block">Presentación</span>
                    <select
                      value={line.presentationId}
                      onChange={(event) => {
                        const next = available.find((presentation) => presentation.id === Number(event.target.value));
                        updateLine(line.key, {
                          presentationId: event.target.value,
                          factor: next ? String(next.base_units_per_presentation) : '',
                        });
                      }}
                      disabled={disabled}
                      className={inputClass}
                    >
                      {available.map((presentation) => (
                        <option key={presentation.id} value={presentation.id} disabled={selectedIds.has(presentation.id) && presentation.id !== Number(line.presentationId)}>
                          {presentation.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-[#A6A6B2]">
                    <span className="mb-1 block">Cantidad</span>
                    <input value={line.quantity} onChange={(event) => updateLine(line.key, { quantity: event.target.value })} inputMode="decimal" disabled={disabled} className={inputClass} />
                  </label>
                  <label className="text-xs text-[#A6A6B2]">
                    <span className="mb-1 block">Conversión</span>
                    <input value={line.factor} onChange={(event) => updateLine(line.key, { factor: event.target.value })} inputMode="decimal" disabled={disabled} className={inputClass} />
                  </label>
                  <button type="button" onClick={() => onChange({ ...capture, lines: capture.lines.filter((candidate) => candidate.key !== line.key) })} disabled={disabled} aria-label={`Quitar ${selected?.name ?? 'presentación'}`} className="rounded-lg border border-red-400/25 px-3 py-2 text-xs text-red-200">Quitar</button>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <button type="button" onClick={addLine} disabled={disabled || !itemId || available.length === capture.lines.length} className="rounded-lg border border-[#3A3A48] px-3 py-2 text-xs text-[#D0D0D8] disabled:opacity-35">
              Añadir presentación
            </button>
            <div className="text-sm font-semibold text-[#FEEF00]">
              Total: {formatQuantity(total)} {item?.unit_name ?? 'unidades base'}
            </div>
          </div>
          {itemId && available.length === 0 ? (
            <p className="mt-3 text-xs leading-5 text-[#858591]">
              Este ítem todavía no tiene presentaciones configuradas. Puedes registrar directamente sus unidades base.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ReceiptDifferenceBadge({ receipt }: { receipt: RecentReceipt }) {
  if (receipt.expected_flow_id == null) {
    return <span className="rounded-full border border-sky-400/30 px-2.5 py-1 text-xs text-sky-200">No planificada</span>;
  }
  if (receipt.difference_quantity_units == null) {
    return <span className="rounded-full border border-emerald-400/30 px-2.5 py-1 text-xs text-emerald-200">Cantidad antes desconocida</span>;
  }
  if (Number(receipt.difference_quantity_units) === 0) {
    return <span className="rounded-full border border-emerald-400/30 px-2.5 py-1 text-xs text-emerald-200">Exacta</span>;
  }
  return (
    <span className="rounded-full border border-amber-400/30 px-2.5 py-1 text-xs text-amber-200">
      Diferencia {formatQuantity(receipt.difference_quantity_units)}
    </span>
  );
}

function SummaryCard({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: number;
  tone?: 'default' | 'good' | 'warn' | 'danger';
}) {
  const valueClass = {
    default: 'text-white',
    good: 'text-emerald-300',
    warn: 'text-amber-300',
    danger: 'text-red-300',
  }[tone];
  return (
    <div className="rounded-2xl border border-[#292938] bg-[#111117] p-4">
      <div className="text-xs uppercase tracking-wide text-[#858591]">{label}</div>
      <div className={`mt-2 text-2xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
