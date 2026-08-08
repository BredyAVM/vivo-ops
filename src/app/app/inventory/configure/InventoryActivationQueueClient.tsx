'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { parseDecimalInput } from '@/lib/number-input';
import {
  activateInventoryDraftAction,
  submitInventoryDraftOpeningAction,
} from '../actions';

type ActivationError = {
  code: string;
  message: string;
};

type ActivationProductItem = {
  inventory_item_id: number;
  name: string;
  is_active: boolean;
  tracking_mode: string;
  accepted_opening: boolean;
  will_activate: boolean;
};

type ActivationProduct = {
  id: number;
  sku: string | null;
  name: string;
  inventory_policy: 'self' | 'direct' | 'components' | 'none';
  diagnostics: {
    ready: boolean;
    errors: ActivationError[];
    items: ActivationProductItem[];
    items_to_activate: number[];
  };
};

type ActivationItem = {
  id: number;
  name: string;
  unit_name: string;
  tracking_mode: 'transactional' | 'periodic_count' | 'not_tracked';
  current_stock_units: number;
  opening_status: 'pending' | 'under_review' | 'accepted' | 'not_required';
  latest_count_id: number | null;
  can_activate: boolean;
  needs_opening: boolean;
  linked_products: Array<{ id: number; name: string }>;
};

export type InventoryActivationQueue = {
  products: ActivationProduct[];
  items: ActivationItem[];
  catalog_ready: boolean;
};

const inputClass =
  'w-full rounded-lg border border-[#343444] bg-[#0D0D12] px-3 py-2 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';

const openingLabels: Record<ActivationItem['opening_status'], string> = {
  pending: 'Pendiente de conteo inicial',
  under_review: 'En revisión o reconteo',
  accepted: 'Apertura aceptada',
  not_required: 'No requiere apertura',
};

function normalizedNumber(value: string) {
  return parseDecimalInput(value);
}

export default function InventoryActivationQueueClient({
  queue,
}: {
  queue: InventoryActivationQueue;
}) {
  const router = useRouter();
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState<Record<number, string>>({});
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const products = queue?.products ?? [];
  const items = queue?.items ?? [];

  function submitOpening(item: ActivationItem) {
    setError(null);
    setMessage(null);
    const quantity = normalizedNumber(quantities[item.id] ?? '');
    if (!Number.isFinite(quantity) || quantity < 0) {
      setError(`Escribe una cantidad física válida para ${item.name}.`);
      return;
    }

    const target = `opening:${item.id}`;
    setActiveTarget(target);
    startTransition(async () => {
      try {
        const result = await submitInventoryDraftOpeningAction({
          operationId: crypto.randomUUID(),
          inventoryItemId: item.id,
          countedQuantityUnits: quantity,
          notes: notes[item.id] ?? null,
        });
        router.push(`/app/inventory/counts/${result.countId}`);
        router.refresh();
      } catch (submissionError) {
        setError(
          submissionError instanceof Error
            ? submissionError.message
            : 'No se pudo presentar la apertura incremental.',
        );
      } finally {
        setActiveTarget(null);
      }
    });
  }

  function activateDraft(input: { productId?: number; inventoryItemId?: number; label: string }) {
    setError(null);
    setMessage(null);
    const target = input.productId ? `product:${input.productId}` : `item:${input.inventoryItemId}`;
    setActiveTarget(target);
    startTransition(async () => {
      try {
        await activateInventoryDraftAction({
          productId: input.productId ?? null,
          inventoryItemId: input.inventoryItemId ?? null,
        });
        setMessage(`${input.label} quedó activo y validado.`);
        router.refresh();
      } catch (activationError) {
        setError(
          activationError instanceof Error
            ? activationError.message
            : 'No se pudo activar el borrador.',
        );
      } finally {
        setActiveTarget(null);
      }
    });
  }

  return (
    <section className="rounded-2xl border border-[#2C2C3A] bg-[#101016] p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Cola de validación y activación</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[#92929F]">
            Los ítems con existencia se cuentan y revisan mientras siguen inactivos. Solo después se
            activan los ítems y productos cuya configuración esté completa.
          </p>
        </div>
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${queue?.catalog_ready ? 'border-emerald-400/30 bg-emerald-400/5 text-emerald-200' : 'border-[#383847] text-[#A8A8B4]'}`}>
          Catálogo global: {queue?.catalog_ready ? 'canónico' : 'sin apertura completa'}
        </span>
      </div>

      {error ? (
        <div role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/5 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      {message ? (
        <div role="status" className="mt-4 rounded-xl border border-emerald-400/30 bg-emerald-400/5 px-4 py-3 text-sm text-emerald-100">
          {message}
        </div>
      ) : null}

      {items.length === 0 && products.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-[#343444] px-4 py-8 text-center text-sm text-[#858591]">
          No hay borradores pendientes. Los que guardes en el configurador aparecerán aquí.
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="mt-6">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-[#B4B4BE]">Ítems físicos pendientes</h3>
          <div className="mt-3 grid gap-4 xl:grid-cols-2">
            {items.map((item) => {
              const openingTarget = `opening:${item.id}`;
              const itemTarget = `item:${item.id}`;
              return (
                <article key={item.id} className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{item.name}</div>
                      <div className="mt-1 text-xs text-[#858591]">
                        #{item.id} · {item.tracking_mode} · saldo actual {item.current_stock_units} {item.unit_name}
                      </div>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs ${item.opening_status === 'accepted' || item.opening_status === 'not_required' ? 'border-emerald-400/30 text-emerald-200' : item.opening_status === 'under_review' ? 'border-amber-400/30 text-amber-200' : 'border-[#3A3A48] text-[#A6A6B2]'}`}>
                      {openingLabels[item.opening_status]}
                    </span>
                  </div>

                  {item.linked_products.length > 0 ? (
                    <div className="mt-3 text-xs text-[#92929F]">
                      Vinculado a: {item.linked_products.map((product) => product.name).join(', ')}
                    </div>
                  ) : null}

                  {item.needs_opening ? (
                    <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
                      <label className="text-xs text-[#A6A6B2]">
                        <span className="mb-1.5 block">Cantidad física inicial</span>
                        <input
                          value={quantities[item.id] ?? ''}
                          onChange={(event) => setQuantities((current) => ({ ...current, [item.id]: event.target.value }))}
                          inputMode="decimal"
                          disabled={isPending}
                          className={inputClass}
                        />
                      </label>
                      <label className="text-xs text-[#A6A6B2]">
                        <span className="mb-1.5 block">Nota opcional</span>
                        <input
                          value={notes[item.id] ?? ''}
                          onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                          maxLength={1000}
                          disabled={isPending}
                          className={inputClass}
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => submitOpening(item)}
                        disabled={isPending}
                        className="rounded-lg bg-[#FEEF00] px-3 py-2 text-xs font-bold text-black disabled:opacity-50"
                      >
                        {activeTarget === openingTarget ? 'Presentando…' : 'Presentar apertura'}
                      </button>
                    </div>
                  ) : null}

                  {item.opening_status === 'under_review' && item.latest_count_id ? (
                    <Link href={`/app/inventory/counts/${item.latest_count_id}`} prefetch={false} className="mt-4 inline-flex rounded-lg border border-amber-400/30 px-3 py-2 text-xs font-semibold text-amber-200">
                      Revisar conteo #{item.latest_count_id}
                    </Link>
                  ) : null}

                  {item.can_activate ? (
                    <button
                      type="button"
                      onClick={() => activateDraft({ inventoryItemId: item.id, label: item.name })}
                      disabled={isPending}
                      className="mt-4 rounded-lg border border-emerald-400/35 bg-emerald-400/5 px-3 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-50"
                    >
                      {activeTarget === itemTarget ? 'Activando…' : 'Activar ítem'}
                    </button>
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      {products.length > 0 ? (
        <div className="mt-7">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-[#B4B4BE]">Productos pendientes</h3>
          <div className="mt-3 grid gap-4 xl:grid-cols-2">
            {products.map((product) => {
              const diagnostics = product.diagnostics;
              const productTarget = `product:${product.id}`;
              return (
                <article key={product.id} className="rounded-xl border border-[#292938] bg-[#14141C] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">{product.name}</div>
                      <div className="mt-1 text-xs text-[#858591]">#{product.id} · {product.sku ?? 'sin SKU'} · {product.inventory_policy}</div>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs ${diagnostics.ready ? 'border-emerald-400/30 text-emerald-200' : 'border-amber-400/30 text-amber-200'}`}>
                      {diagnostics.ready ? 'Listo para activar' : `${diagnostics.errors.length} pendiente(s)`}
                    </span>
                  </div>

                  {diagnostics.items.length > 0 ? (
                    <div className="mt-3 space-y-1 text-xs text-[#9C9CA8]">
                      {diagnostics.items.map((item) => (
                        <div key={`${product.id}:${item.inventory_item_id}`}>
                          {item.name}: {item.accepted_opening ? 'apertura aceptada' : 'apertura pendiente'}
                          {item.will_activate ? ' · se activará junto al producto' : ''}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {diagnostics.errors.length > 0 ? (
                    <ul className="mt-3 space-y-1 text-xs leading-5 text-amber-100/80">
                      {diagnostics.errors.slice(0, 5).map((diagnosticError) => (
                        <li key={`${diagnosticError.code}:${diagnosticError.message}`}>• {diagnosticError.message}</li>
                      ))}
                    </ul>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => activateDraft({ productId: product.id, label: product.name })}
                    disabled={isPending || !diagnostics.ready}
                    className="mt-4 rounded-lg bg-[#FEEF00] px-3 py-2 text-xs font-bold text-black disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {activeTarget === productTarget ? 'Activando…' : 'Validar y activar producto'}
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}
