"use client";

import { useRef, useState } from "react";
import { appendMasterOpsGiftAction, type MasterOpsEditCatalogItem, type MasterOpsEditOrder } from "./actions";

export default function MasterOpsGiftAppend({ order, catalog, disabled, onSaved }: {
  order: MasterOpsEditOrder; catalog: MasterOpsEditCatalogItem[];
  disabled: boolean; onSaved: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  // Keep the same key after an uncertain network response; reset only on a different request.
  const request = useRef<{ signature: string; id: string } | null>(null);
  const gifts = catalog.filter((p) => p.isActive && p.type === "gambit" &&
    p.discretionaryAllowed !== false && !p.isDetailEditable && p.sourcePriceAmount === 0 && p.basePriceUsd === 0);
  if (!["created", "queued", "confirmed", "in_kitchen", "ready", "out_for_delivery"].includes(order.status) || !gifts.length) return null;

  async function addGift() {
    if (pending.current || disabled) return;
    const quantity = Number(qty);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || reason.trim().length < 4) {
      setError("Selecciona el obsequio, la cantidad entera y un motivo."); return;
    }
    const signature = JSON.stringify([order.id, productId, quantity, reason.trim()]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await appendMasterOpsGiftAction({ orderId: order.id, productId: Number(productId), qty: quantity,
        expectedLastModifiedAt: order.lastModifiedAtISO, operationId: request.current.id, reason: reason.trim() });
      if (!result.ok) { setError(result.message); return; }
      onSaved();
    } catch {
      setError("No se pudo confirmar la respuesta. Puedes reintentar: la misma solicitud no duplica el obsequio.");
    } finally { pending.current = false; setBusy(false); }
  }

  return <details open={order.status === "out_for_delivery" ? true : undefined} className="mb-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
    <summary className="cursor-pointer text-sm font-semibold text-emerald-200">Agregar obsequio sin cambiar el pago</summary>
    <p className="mt-2 text-xs text-[#B7B7C2]">Guarda únicamente el obsequio. Conserva precios, pago y estado de la orden. Avisa a cocina.</p>
    {order.status === "out_for_delivery" ? <p className="mt-2 text-xs text-amber-200">La orden ya salió: confirma con cocina y el motorizado la entrega del obsequio. Se registra su salida de inventario.</p> : null}
    {disabled ? <p className="mt-2 text-xs text-amber-200">Hay cambios en el editor. Guarda esos cambios o cierra y vuelve a abrir la orden para agregar solo el obsequio.</p> : null}
    <fieldset disabled={disabled || busy} onKeyDown={(event) => {
      // This panel can live inside the general editor form. Enter must never submit that form.
      if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
        event.preventDefault(); void addGift();
      }
    }} className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr] disabled:opacity-60">
      <label className="text-xs">Obsequio
        <select className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">Seleccionar…</option>
          {gifts.map((p) => <option key={p.id} value={p.id}>{p.name} — $0</option>)}
        </select>
      </label>
      <label className="text-xs">Cantidad de obsequios
        <input className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" type="number" min="1" step="1" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <label className="text-xs sm:col-span-2">Motivo
        <input className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Faltó agregar el Dondy de obsequio" />
      </label>
      <button type="button" onClick={addGift} className="rounded-lg bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-black sm:col-span-2">{busy ? "Agregando…" : "Agregar solo este obsequio"}</button>
    </fieldset>
    {error ? <p role="alert" className="mt-2 text-sm text-red-300">{error}</p> : null}
  </details>;
}
