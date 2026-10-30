"use client";

import { useRef, useState } from "react";
import { appendMasterOpsBeverageAction, type MasterOpsEditCatalogItem, type MasterOpsEditOrder } from "./actions";

const amount = (value: number) => value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function MasterOpsBeverageAppend({ order, catalog, onSaved }: {
  order: MasterOpsEditOrder; catalog: MasterOpsEditCatalogItem[]; onSaved: () => void;
}) {
  const [productId, setProductId] = useState("");
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [physicallyIncluded, setPhysicallyIncluded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ inventoryStatus: string; totalBs: number; totalUsd: number } | null>(null);
  const pending = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const beverages = catalog.filter(p => p.isActive && p.type === "product" && p.inventoryGroup === "beverages"
    && !p.isDetailEditable && p.sourcePriceAmount > 0 && p.discretionaryAllowed !== false);
  if (order.status !== "out_for_delivery" || order.fulfillment !== "delivery") return null;

  async function addBeverage() {
    if (pending.current || saved) return;
    const quantity = Number(qty);
    if (!productId || !Number.isInteger(quantity) || quantity <= 0 || quantity > 999 || reason.trim().length < 4 || !physicallyIncluded) {
      setError("Selecciona la bebida, cantidad y motivo; confirma que acompaña el envío."); return;
    }
    const signature = JSON.stringify([order.id, productId, quantity, reason.trim()]);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await appendMasterOpsBeverageAction({ orderId: order.id, productId: Number(productId), qty: quantity,
        expectedLastModifiedAt: order.lastModifiedAtISO, operationId: request.current.id, reason: reason.trim() });
      if (!result.ok) { setError(result.message); return; }
      setSaved(result);
    } catch {
      setError("No se pudo confirmar la respuesta. Reintenta la misma solicitud: no duplica la bebida.");
    } finally { pending.current = false; setBusy(false); }
  }

  return <section className="mb-4 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3" aria-labelledby="beverage-append-title">
    <h2 id="beverage-append-title" className="text-sm font-semibold text-sky-200">Agregar bebida al envío</h2>
    <p className="mt-2 text-xs text-[#B7B7C2]">Precio normal de catálogo. Actualiza el total y el pendiente de esta misma orden, conservando sus productos, pagos y estado en camino.</p>
    <fieldset disabled={busy || saved !== null} className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr] disabled:opacity-60">
      <label className="text-xs">Bebida
        <select className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" value={productId} onChange={e => setProductId(e.target.value)}>
          <option value="">Seleccionar…</option>
          {beverages.map(p => <option key={p.id} value={p.id}>{p.name} — {p.sourcePriceCurrency === "VES" ? "Bs" : "$"} {amount(p.sourcePriceAmount)}</option>)}
        </select>
      </label>
      <label className="text-xs">Cantidad
        <input className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" type="number" min="1" max="999" step="1" value={qty} onChange={e => setQty(e.target.value)} />
      </label>
      <label className="text-xs sm:col-span-2">Motivo
        <input className="mt-1 w-full rounded-lg border border-[#242433] bg-[#0B0B0D] p-2" maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} placeholder="La bebida acompaña el envío y faltaba en el pedido" />
      </label>
      <label className="flex items-start gap-2 text-xs sm:col-span-2">
        <input type="checkbox" checked={physicallyIncluded} onChange={e => setPhysicallyIncluded(e.target.checked)} />
        Confirmé que esta bebida acompaña físicamente el envío. Se registrará su salida de inventario.
      </label>
      <button type="button" onClick={addBeverage} disabled={!beverages.length} className="rounded-lg bg-[#FEEF00] px-3 py-2 text-sm font-semibold text-black disabled:opacity-50 sm:col-span-2">{busy ? "Agregando…" : "Agregar y actualizar el total"}</button>
    </fieldset>
    {error ? <p role="alert" className="mt-2 text-sm text-red-300">{error}</p> : null}
    {saved ? <div role="status" className="mt-3 text-sm text-emerald-200">
      <p>Bebida agregada. Total: Bs {amount(saved.totalBs)} / ${amount(saved.totalUsd)}.</p>
      {saved.inventoryStatus === "review_required" ? <p className="mt-2 text-amber-200">El cobro quedó actualizado. Inventario generó una incidencia que necesita revisión; no vuelvas a agregar la bebida.</p> : null}
      <button type="button" onClick={onSaved} className="mt-3 rounded-lg border border-[#242433] px-3 py-2">Ver orden actualizada</button>
    </div> : null}
  </section>;
}
