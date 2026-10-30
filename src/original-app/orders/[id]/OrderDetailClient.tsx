"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase";

type OrderItemRow = {
  id: number;
  order_id: number;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  qty: number;
  unit_price_usd_snapshot: number;
  line_total_usd: number;
  override_unit_price_usd?: number | null;
  override_reason?: string | null;
  override_approved_by?: string | null;
  override_approved_at?: string | null;
};

type ProductRow = {
  id: number;
  sku: string | null;
  name: string;
  base_price_usd: number | string | null;
  is_active?: boolean;
};

type EditableRowState = {
  qty: number;
  usePriceOverride: boolean;
  overrideUnitPrice: string;
  overrideReason: string;
};

type Fulfillment = "pickup" | "delivery";

type OrderStatus =
  | "created"
  | "queued"
  | "confirmed"
  | "in_kitchen"
  | "ready"
  | "out_for_delivery"
  | "delivered"
  | "cancelled";

type PaymentSummary = {
  pending_reports: number;
  confirmed_reports: number;
  rejected_reports: number;

  order_total_usd: number;
  confirmed_usd: number;
  remaining_usd: number;
  relation_status: "PARTIAL" | "PAID" | "OVERPAID";
};

type DriverOption = {
  user_id: string;
  full_name: string;
  is_active: boolean;
};

type PartnerOption = {
  id: number;
  name: string;
  is_active: boolean;
};

type DeliveryTripRow = {
  order_id: number;
  delivery_mode: "internal" | "external";
  internal_driver_user_id: string | null;
  external_partner_id: number | null;
  distance_km: number | null;
  fee_usd: number | null;
  fee_ves: number | null;
  exchange_rate_ves_per_usd: number | null;
  notes: string | null;
};

export default function OrderDetailClient() {
  const router = useRouter();
  const params = useParams();
  const rawId = params?.id;
  const orderId = Number(Array.isArray(rawId) ? rawId[0] : rawId);

  const supabase = useMemo(() => createSupabaseBrowser(), []);

  // auth/roles
  const [userId, setUserId] = useState<string | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const isAdmin = roles.includes("admin");
  const isMaster = roles.includes("master");
  const isKitchen = roles.includes("kitchen");
  const isDriver = roles.includes("driver");
  const isAdvisor = roles.includes("advisor");
  const canMasterOrAdmin = isAdmin || isMaster;

  // order
  const [orderTotal, setOrderTotal] = useState<number>(0);
  const [fulfillment, setFulfillment] = useState<Fulfillment>("pickup");
  const [orderStatus, setOrderStatus] = useState<OrderStatus>("created");
  const [isPriceLocked, setIsPriceLocked] = useState<boolean>(false);
  const [orderNotes, setOrderNotes] = useState<string>("");

  const [deliveryMode, setDeliveryMode] = useState<"internal" | "external" | null>(null);
  const [internalDriverUserId, setInternalDriverUserId] = useState<string | null>(null);
  const [externalPartnerId, setExternalPartnerId] = useState<number | null>(null);
  const [externalReference, setExternalReference] = useState<string>("");

  // delivery UI lists
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [partners, setPartners] = useState<PartnerOption[]>([]);

  // delivery trip fields
  const [tripDistanceKm, setTripDistanceKm] = useState<string>("");
  const [tripFeeUsd, setTripFeeUsd] = useState<string>("");
  const [tripNotes, setTripNotes] = useState<string>("");

  // items/products
  const [items, setItems] = useState<OrderItemRow[]>([]);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [selectedProductId, setSelectedProductId] = useState<number | "">("");
  const [qty, setQty] = useState<number>(1);

  // edit item
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [rowEdit, setRowEdit] = useState<EditableRowState | null>(null);

  // payments summary
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary>({
    pending_reports: 0,
    confirmed_reports: 0,
    rejected_reports: 0,
    order_total_usd: 0,
    confirmed_usd: 0,
    remaining_usd: 0,
    relation_status: "PARTIAL",
  });

  // ui
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedProduct = useMemo(() => {
    if (selectedProductId === "") return null;
    return products.find((p) => p.id === selectedProductId) ?? null;
  }, [products, selectedProductId]);

  // --------- locks (rules) ----------
  const advisorLockedStatuses: OrderStatus[] = [
    "confirmed",
    "in_kitchen",
    "ready",
    "out_for_delivery",
    "delivered",
    "cancelled",
  ];

  const itemsLockedForNonPrivileged =
    !canMasterOrAdmin && advisorLockedStatuses.includes(orderStatus);

  const canEditItemsByStatus = !itemsLockedForNonPrivileged || canMasterOrAdmin;
  const canEditItemsByPriceLock = !isPriceLocked || canMasterOrAdmin;
  const canMutateItems = canEditItemsByStatus && canEditItemsByPriceLock;

  // ---------- load ----------
  async function loadAll() {
    setLoading(true);
    setError(null);

    if (!Number.isFinite(orderId)) {
      setError("Invalid order id.");
      setLoading(false);
      return;
    }

    try {
      // auth
      const { data: authRes, error: authErr } = await supabase.auth.getUser();
      if (authErr) throw new Error(authErr.message);
      if (!authRes.user) {
        router.push("/login");
        return;
      }
      setUserId(authRes.user.id);

      // roles
      const { data: roleData, error: roleErr } = await supabase.rpc("get_my_roles");
      if (roleErr) throw new Error(roleErr.message);
      setRoles((roleData ?? []) as string[]);

      // order
      const { data: orderData, error: orderErr } = await supabase
        .from("orders")
        .select(
          "total_usd, fulfillment, status, is_price_locked, notes, delivery_mode, internal_driver_user_id, external_partner_id, external_reference"
        )
        .eq("id", orderId)
        .single();
      if (orderErr) throw new Error(orderErr.message);

      setOrderTotal(Number(orderData?.total_usd ?? 0));
      setFulfillment((orderData?.fulfillment ?? "pickup") as Fulfillment);
      setOrderStatus((orderData?.status ?? "created") as OrderStatus);
      setIsPriceLocked(Boolean(orderData?.is_price_locked));
      setOrderNotes(orderData?.notes ?? "");

      setDeliveryMode((orderData?.delivery_mode ?? null) as any);
      setInternalDriverUserId(orderData?.internal_driver_user_id ?? null);
      setExternalPartnerId(orderData?.external_partner_id != null ? Number(orderData.external_partner_id) : null);
      setExternalReference(orderData?.external_reference ?? "");

      // items
      const { data: itemsData, error: itemsErr } = await supabase
        .from("order_items")
        .select(
          "id, order_id, sku_snapshot, product_name_snapshot, qty, unit_price_usd_snapshot, line_total_usd, override_unit_price_usd, override_reason, override_approved_by, override_approved_at"
        )
        .eq("order_id", orderId)
        .order("id", { ascending: true });
      if (itemsErr) throw new Error(itemsErr.message);
      setItems((itemsData ?? []) as OrderItemRow[]);

      // products
      const { data: productsData, error: prodErr } = await supabase
        .from("products")
        .select("id, sku, name, base_price_usd, is_active")
        .eq("is_active", true)
        .order("name", { ascending: true });
      if (prodErr) throw new Error(prodErr.message);
      setProducts((productsData ?? []) as ProductRow[]);

      // payment reports (workflow)
      const { data: prRows, error: prErr } = await supabase
        .from("payment_reports")
        .select("status, reported_amount_usd_equivalent")
        .eq("order_id", orderId);
      if (prErr) throw new Error(prErr.message);

      const pending_reports = (prRows ?? []).filter((r: any) => r.status === "pending").length;
      const confirmed_reports = (prRows ?? []).filter((r: any) => r.status === "confirmed").length;
      const rejected_reports = (prRows ?? []).filter((r: any) => r.status === "rejected").length;

      // money movements (real)
      const { data: mvRows, error: mvErr } = await supabase
        .from("money_movements")
        .select("amount_usd_equivalent")
        .eq("order_id", orderId)
        .eq("direction", "inflow")
        .eq("movement_type", "order_payment");
      if (mvErr) throw new Error(mvErr.message);

      const confirmed_usd = (mvRows ?? []).reduce(
        (acc: number, m: any) => acc + Number(m.amount_usd_equivalent ?? 0),
        0
      );

      const order_total_usd = Number(orderData?.total_usd ?? 0);
      const remaining_usd = order_total_usd - confirmed_usd;

      let relation_status: "PARTIAL" | "PAID" | "OVERPAID" = "PARTIAL";
      if (order_total_usd > 0 && remaining_usd <= 0) {
        relation_status = confirmed_usd > order_total_usd ? "OVERPAID" : "PAID";
      } else if (order_total_usd === 0 && confirmed_usd > 0) {
        relation_status = "OVERPAID";
      }

      setPaymentSummary({
        pending_reports,
        confirmed_reports,
        rejected_reports,
        order_total_usd,
        confirmed_usd,
        remaining_usd,
        relation_status,
      });

      // drivers + partners + trip (solo si master/admin y delivery)
      if ((orderData?.fulfillment ?? "pickup") === "delivery") {
        await loadDriversAndPartners();
        await loadTrip();
      } else {
        setDrivers([]);
        setPartners([]);
        setTripDistanceKm("");
        setTripFeeUsd("");
        setTripNotes("");
      }
    } catch (e: any) {
      setError(e?.message ?? "Unknown error");
      setItems([]);
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }

  async function loadDriversAndPartners() {
    // Drivers: user_roles(role=driver) -> profiles
    const { data: driverRoleRows, error: driverRoleErr } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "driver");

    if (driverRoleErr) throw new Error(driverRoleErr.message);

    const driverIds = Array.from(new Set((driverRoleRows ?? []).map((r: any) => String(r.user_id))));

    let driverOptions: DriverOption[] = [];
    if (driverIds.length > 0) {
      const { data: profileRows, error: profilesErr } = await supabase
        .from("profiles")
        .select("id, full_name, is_active")
        .in("id", driverIds);

      if (profilesErr) throw new Error(profilesErr.message);

      driverOptions = (profileRows ?? [])
        .map((p: any) => ({
          user_id: String(p.id),
          full_name: String(p.full_name ?? "Sin nombre"),
          is_active: Boolean(p.is_active ?? true),
        }))
        .filter((d) => d.is_active)
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
    }
    setDrivers(driverOptions);

    // Partners externos
    const { data: partnerRows, error: partnerErr } = await supabase
      .from("delivery_partners")
      .select("id, name, is_active")
      .eq("is_active", true)
      .order("name", { ascending: true });

    if (partnerErr) throw new Error(partnerErr.message);

    setPartners((partnerRows ?? []).map((p: any) => ({
      id: Number(p.id),
      name: String(p.name),
      is_active: Boolean(p.is_active ?? true),
    })));
  }

  async function loadTrip() {
    const { data, error } = await supabase
      .from("delivery_trips")
      .select("order_id, delivery_mode, internal_driver_user_id, external_partner_id, distance_km, fee_usd, fee_ves, exchange_rate_ves_per_usd, notes")
      .eq("order_id", orderId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const row = data as DeliveryTripRow | null;
    if (!row) {
      setTripDistanceKm("");
      setTripFeeUsd("");
      setTripNotes("");
      return;
    }

    setTripDistanceKm(row.distance_km == null ? "" : String(row.distance_km));
    setTripFeeUsd(row.fee_usd == null ? "" : String(row.fee_usd));
    setTripNotes(row.notes ?? "");
  }

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId]);

  // ---------- helpers ----------
  async function recalcOrderTotal() {
    const { data: rows, error: sumError } = await supabase
      .from("order_items")
      .select("line_total_usd")
      .eq("order_id", orderId);

    if (sumError) throw new Error(sumError.message);

    const total = (rows ?? []).reduce(
      (acc: number, r: any) => acc + Number(r.line_total_usd ?? 0),
      0
    );

    const { error: updError } = await supabase
      .from("orders")
      .update({ total_usd: total })
      .eq("id", orderId);

    if (updError) throw new Error(updError.message);
  }

  // ✅ NEW: Master/Admin approve to queue (created -> queued)
  async function approveToQueue() {
    if (!canMasterOrAdmin) {
      setError("Solo master/admin puede aprobar y poner en cola.");
      return;
    }
    if (orderStatus !== "created") {
      setError("Solo se puede pasar a cola desde 'created'.");
      return;
    }

    const ok = window.confirm("¿Aprobar esta orden y pasarla a cola (queued)?");
    if (!ok) return;

    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("orders")
        .update({ status: "queued" })
        .eq("id", orderId);

      if (updErr) throw new Error(updErr.message);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error pasando a cola");
    } finally {
      setSaving(false);
    }
  }

  // ✅ Optional: Master/Admin return to created (queued -> created)
  async function returnToCreated() {
    if (!canMasterOrAdmin) {
      setError("Solo master/admin puede devolver a created.");
      return;
    }
    if (orderStatus !== "queued") {
      setError("Solo se puede devolver a created desde 'queued'.");
      return;
    }

    const ok = window.confirm("¿Devolver esta orden a 'created' para corrección?");
    if (!ok) return;

    setSaving(true);
    setError(null);
    try {
      const { error: updErr } = await supabase
        .from("orders")
        .update({ status: "created" })
        .eq("id", orderId);

      if (updErr) throw new Error(updErr.message);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error devolviendo a created");
    } finally {
      setSaving(false);
    }
  }

  // ---------- items CRUD ----------
  async function addItem() {
    setError(null);

    if (!canMutateItems) {
      setError(isPriceLocked ? "Pedido bloqueado por precio (solo master/admin)." : "Items bloqueados por status.");
      return;
    }

    if (selectedProductId === "") {
      setError("Selecciona un producto.");
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      setError("Qty debe ser > 0.");
      return;
    }

    const product = products.find((p) => p.id === selectedProductId);
    if (!product) {
      setError("Producto no encontrado.");
      return;
    }

    setSaving(true);
    try {
      // NO enviamos pricing, DB lo calcula
      const { error: insertError } = await supabase.from("order_items").insert({
        order_id: orderId,
        product_id: product.id,
        qty,
        sku_snapshot: product.sku ?? null,
        product_name_snapshot: product.name,
        notes: null,
      });

      if (insertError) throw new Error(insertError.message);

      await recalcOrderTotal();

      setSelectedProductId("");
      setQty(1);

      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error inserting item");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(item: OrderItemRow) {
    setError(null);
    setEditingItemId(item.id);

    const effectiveUnit =
      item.override_unit_price_usd != null
        ? Number(item.override_unit_price_usd)
        : Number(item.unit_price_usd_snapshot ?? 0);

    setRowEdit({
      qty: Number(item.qty ?? 1),
      usePriceOverride: isAdmin ? item.override_unit_price_usd != null : false,
      overrideUnitPrice: String(effectiveUnit),
      overrideReason: isAdmin ? (item.override_reason ?? "") : "",
    });
  }

  function cancelEdit() {
    setEditingItemId(null);
    setRowEdit(null);
  }

  async function saveItemEdit(item: OrderItemRow) {
    setError(null);
    if (!rowEdit) return;

    if (!canMutateItems) {
      setError(isPriceLocked ? "Pedido bloqueado por precio (solo master/admin)." : "Items bloqueados por status.");
      return;
    }

    if (!Number.isFinite(rowEdit.qty) || rowEdit.qty <= 0) {
      setError("Qty debe ser > 0.");
      return;
    }

    setSaving(true);
    try {
      const payload: any = { qty: rowEdit.qty };

      if (isAdmin) {
        if (rowEdit.usePriceOverride) {
          const overridePrice = Number(rowEdit.overrideUnitPrice);
          if (!Number.isFinite(overridePrice) || overridePrice < 0) throw new Error("Override price inválido.");
          if (rowEdit.overrideReason.trim() === "") throw new Error("Debes indicar motivo del override.");

          payload.override_unit_price_usd = overridePrice;
          payload.override_reason = rowEdit.overrideReason.trim();
        } else {
          payload.override_unit_price_usd = null;
          payload.override_reason = null;
        }
      }

      const { error: updError } = await supabase
        .from("order_items")
        .update(payload)
        .eq("id", item.id)
        .eq("order_id", orderId);

      if (updError) throw new Error(updError.message);

      await recalcOrderTotal();
      await loadAll();
      cancelEdit();
    } catch (e: any) {
      setError(e?.message ?? "Error updating item");
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(itemId: number) {
    setError(null);

    if (!canMutateItems) {
      setError(isPriceLocked ? "Pedido bloqueado por precio (solo master/admin)." : "Items bloqueados por status.");
      return;
    }

    const ok = window.confirm("¿Eliminar este item del pedido?");
    if (!ok) return;

    setSaving(true);
    try {
      const { error: delError } = await supabase
        .from("order_items")
        .delete()
        .eq("id", itemId)
        .eq("order_id", orderId);

      if (delError) throw new Error(delError.message);

      await recalcOrderTotal();
      await loadAll();

      if (editingItemId === itemId) cancelEdit();
    } catch (e: any) {
      setError(e?.message ?? "Error deleting item");
    } finally {
      setSaving(false);
    }
  }

  async function toggleLock() {
    if (!canMasterOrAdmin) {
      setError("Solo master/admin puede lock/unlock.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const { error: updError } = await supabase
        .from("orders")
        .update({ is_price_locked: !isPriceLocked })
        .eq("id", orderId);

      if (updError) throw new Error(updError.message);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error updating lock");
    } finally {
      setSaving(false);
    }
  }

  async function saveNotes() {
    setSaving(true);
    setError(null);
    try {
      const { error: updError } = await supabase
        .from("orders")
        .update({ notes: orderNotes.trim() === "" ? null : orderNotes.trim() })
        .eq("id", orderId);

      if (updError) throw new Error(updError.message);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error updating notes");
    } finally {
      setSaving(false);
    }
  }

  // ---------- RPC transitions ----------
  async function rpcCall(fn: string, payload: any) {
    setSaving(true);
    setError(null);
    try {
      const { error } = await supabase.rpc(fn, payload);
      if (error) throw new Error(error.message);
      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "RPC error");
    } finally {
      setSaving(false);
    }
  }

  async function sendToKitchen() {
    await rpcCall("send_to_kitchen", { p_order_id: orderId });
  }

  async function kitchenTake() {
    const etaStr = prompt("ETA minutos (ej 15):", "15");
    if (etaStr == null) return;
    const eta = etaStr.trim() === "" ? null : Number(etaStr);
    if (eta != null && (!Number.isFinite(eta) || eta < 0)) {
      alert("ETA inválido");
      return;
    }
    await rpcCall("kitchen_take", { p_order_id: orderId, p_eta_minutes: eta });
  }

  async function markReady() {
    await rpcCall("mark_ready", { p_order_id: orderId });
  }

  async function outForDelivery() {
    await rpcCall("out_for_delivery", { p_order_id: orderId });
  }

  async function markDelivered() {
    await rpcCall("mark_delivered", { p_order_id: orderId });
  }

  async function saveDeliveryAssignment() {
    if (!canMasterOrAdmin) {
      setError("Solo master/admin puede asignar delivery.");
      return;
    }
    if (fulfillment !== "delivery") {
      setError("Esta orden no es delivery.");
      return;
    }
    if (!(orderStatus === "confirmed" || orderStatus === "in_kitchen" || orderStatus === "ready")) {
      setError("Asignación de delivery permitida solo en confirmed/in_kitchen/ready.");
      return;
    }

    if (deliveryMode == null) {
      setError("Selecciona modo: internal o external.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (deliveryMode === "internal") {
        if (!internalDriverUserId) throw new Error("Selecciona un driver interno.");
        const { error: rpcErr } = await supabase.rpc("assign_internal_driver", {
          p_order_id: orderId,
          p_driver_user_id: internalDriverUserId,
        });
        if (rpcErr) throw new Error(rpcErr.message);
      } else {
        if (!externalPartnerId) throw new Error("Selecciona un partner externo.");
        const { error: rpcErr } = await supabase.rpc("assign_external_partner", {
          p_order_id: orderId,
          p_partner_id: externalPartnerId,
          p_reference: externalReference.trim() === "" ? null : externalReference.trim(),
        });
        if (rpcErr) throw new Error(rpcErr.message);
      }

      const dist = tripDistanceKm.trim() === "" ? null : Number(tripDistanceKm);
      if (dist != null && (!Number.isFinite(dist) || dist < 0)) throw new Error("distance_km inválido");

      const feeU = tripFeeUsd.trim() === "" ? null : Number(tripFeeUsd);
      if (feeU != null && (!Number.isFinite(feeU) || feeU < 0)) throw new Error("fee_usd inválido");

      const tripPayload: any = {
        order_id: orderId,
        delivery_mode: deliveryMode,
        internal_driver_user_id: deliveryMode === "internal" ? internalDriverUserId : null,
        external_partner_id: deliveryMode === "external" ? externalPartnerId : null,
        distance_km: dist,
        fee_usd: feeU,
        notes: tripNotes.trim() === "" ? null : tripNotes.trim(),
        created_by_user_id: userId,
      };

      const { error: upsertErr } = await supabase
        .from("delivery_trips")
        .upsert(tripPayload, { onConflict: "order_id" });

      if (upsertErr) throw new Error(upsertErr.message);

      await loadAll();
    } catch (e: any) {
      setError(e?.message ?? "Error guardando asignación");
    } finally {
      setSaving(false);
    }
  }

  const statusLabel = (s: OrderStatus) => {
    const map: Record<OrderStatus, string> = {
      created: "Nuevo",
      queued: "En cola (aprobado)",
      confirmed: "Enviado a cocina",
      in_kitchen: "En cocina",
      ready: "Listo",
      out_for_delivery: "En ruta",
      delivered: fulfillment === "pickup" ? "Retirado" : "Entregado",
      cancelled: "Cancelado",
    };
    return map[s] ?? s;
  };

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ fontSize: 26, fontWeight: 900, margin: 0 }}>Order Detail</h1>
          <div style={{ opacity: 0.85, marginTop: 6 }}>
            Order ID: <b>{orderId}</b> · Total USD: <b>{orderTotal.toFixed(2)}</b> ·
            Status: <b>{statusLabel(orderStatus)}</b> · Fulfillment: <b>{fulfillment}</b> · Price lock:{" "}
            <b>{isPriceLocked ? "ON" : "OFF"}</b>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {(isAdmin || isMaster) && (
            <button
              onClick={toggleLock}
              disabled={saving}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                background: isPriceLocked ? "#f59e0b" : "#ef4444",
                fontWeight: 900,
              }}
            >
              {isPriceLocked ? "Unlock Order" : "Lock Order"}
            </button>
          )}
        </div>
      </div>

      {loading && <p style={{ marginTop: 12 }}>Cargando…</p>}
      {error && <p style={{ marginTop: 12, color: "tomato" }}>Error: {error}</p>}

      {/* ✅ MASTER APPROVAL FLOW */}
      {!loading && canMasterOrAdmin && (
        <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, maxWidth: 1100 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Aprobación (Master/Admin)</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {orderStatus === "created" && (
              <button
                onClick={approveToQueue}
                disabled={saving}
                style={{
                  background: saving ? "#444" : "#22c55e",
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontWeight: 900,
                  color: "#111",
                }}
              >
                ✅ Aprobar y poner en cola (queued)
              </button>
            )}

            {orderStatus === "queued" && (
              <button
                onClick={returnToCreated}
                disabled={saving}
                style={{
                  background: saving ? "#444" : "#f59e0b",
                  padding: "10px 14px",
                  borderRadius: 10,
                  fontWeight: 900,
                  color: "#111",
                }}
              >
                ↩️ Devolver a created (corrección)
              </button>
            )}
          </div>

          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
            * Este paso es el “OK operativo” del master. Luego el master puede enviar a cocina cuando toque.
          </div>
        </section>
      )}

      {/* Operación por RPC (cocina/delivery) */}
      {!loading && (
        <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, maxWidth: 1100 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Operación (transiciones por RPC)</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {(isAdmin || isMaster) && (orderStatus === "created" || orderStatus === "queued") && (
              <button
                onClick={sendToKitchen}
                disabled={saving}
                style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 900 }}
              >
                Enviar a cocina
              </button>
            )}

            {(isKitchen || isAdmin || isMaster) && orderStatus === "confirmed" && (
              <button
                onClick={kitchenTake}
                disabled={saving}
                style={{ background: "#22c55e", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
              >
                Tomar en cocina (ETA)
              </button>
            )}

            {(isKitchen || isAdmin || isMaster) && (orderStatus === "confirmed" || orderStatus === "in_kitchen") && (
              <button
                onClick={markReady}
                disabled={saving}
                style={{ background: "#f59e0b", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
              >
                Marcar listo
              </button>
            )}

            {(isAdmin || isMaster) && fulfillment === "delivery" && orderStatus === "ready" && (
              <button
                onClick={outForDelivery}
                disabled={saving}
                style={{ background: "#a855f7", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 900 }}
              >
                Salir a ruta
              </button>
            )}

            {(isDriver || isAdmin || isMaster || isKitchen) && (
              <button
                onClick={markDelivered}
                disabled={saving}
                style={{ background: "#ef4444", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 900 }}
              >
                {fulfillment === "pickup" ? "Marcar retirado" : "Marcar entregado"}
              </button>
            )}
          </div>

          <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
            * Cocina/delivery por RPC. Aprobación a cola por update simple (v1).
          </div>
        </section>
      )}

      {/* Delivery Assignment */}
      {!loading && canMasterOrAdmin && fulfillment === "delivery" && (
        <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, maxWidth: 1100 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Delivery · Asignación (Master/Admin)</div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ minWidth: 220 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Modo</div>
              <select
                value={deliveryMode ?? ""}
                onChange={(e) => {
                  const v = e.target.value as any;
                  setDeliveryMode(v === "" ? null : v);
                }}
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving}
              >
                <option value="">— seleccionar —</option>
                <option value="internal">Internal (driver propio)</option>
                <option value="external">External (empresa)</option>
              </select>
            </div>

            {deliveryMode === "internal" && (
              <div style={{ minWidth: 320 }}>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Driver interno</div>
                <select
                  value={internalDriverUserId ?? ""}
                  onChange={(e) => setInternalDriverUserId(e.target.value || null)}
                  style={{ width: "100%", padding: 10, borderRadius: 10 }}
                  disabled={saving}
                >
                  <option value="">— seleccionar driver —</option>
                  {drivers.map((d) => (
                    <option key={d.user_id} value={d.user_id}>
                      {d.full_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {deliveryMode === "external" && (
              <>
                <div style={{ minWidth: 320 }}>
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Partner externo</div>
                  <select
                    value={externalPartnerId ?? ""}
                    onChange={(e) => setExternalPartnerId(e.target.value === "" ? null : Number(e.target.value))}
                    style={{ width: "100%", padding: 10, borderRadius: 10 }}
                    disabled={saving}
                  >
                    <option value="">— seleccionar empresa —</option>
                    {partners.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div style={{ minWidth: 260 }}>
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Referencia (opcional)</div>
                  <input
                    value={externalReference}
                    onChange={(e) => setExternalReference(e.target.value)}
                    placeholder="Ej: guía / ref / código"
                    style={{ width: "100%", padding: 10, borderRadius: 10 }}
                    disabled={saving}
                  />
                </div>
              </>
            )}
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div style={{ minWidth: 160 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Distancia (km) opcional</div>
              <input
                value={tripDistanceKm}
                onChange={(e) => setTripDistanceKm(e.target.value)}
                placeholder="Ej: 4.2"
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving}
              />
            </div>

            <div style={{ minWidth: 160 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Fee USD (opcional)</div>
              <input
                value={tripFeeUsd}
                onChange={(e) => setTripFeeUsd(e.target.value)}
                placeholder="Ej: 3"
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving}
              />
            </div>

            <div style={{ flex: 1, minWidth: 260 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Notas (opcional)</div>
              <input
                value={tripNotes}
                onChange={(e) => setTripNotes(e.target.value)}
                placeholder="Ej: zona, peaje, comentario..."
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving}
              />
            </div>

            <button
              onClick={saveDeliveryAssignment}
              disabled={saving}
              style={{ background: "#22c55e", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
            >
              {saving ? "Guardando…" : "Guardar asignación"}
            </button>
          </div>
        </section>
      )}

      {/* Nota general */}
      {!loading && (
        <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, maxWidth: 1100 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Nota general del pedido</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <input
              value={orderNotes}
              onChange={(e) => setOrderNotes(e.target.value)}
              placeholder="Ej: Cliente paga móvil al recibir / sin picante / llamar al llegar…"
              style={{ flex: 1, minWidth: 280, padding: 10, borderRadius: 10 }}
            />
            <button
              onClick={saveNotes}
              disabled={saving}
              style={{ background: "#22c55e", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
            >
              Guardar nota
            </button>
          </div>
        </section>
      )}

      {/* Items */}
      {!loading && (
        <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, maxWidth: 1100 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Items</div>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <div style={{ minWidth: 280 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Producto</div>
              <select
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value === "" ? "" : Number(e.target.value))}
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving || !canMutateItems}
              >
                <option value="">— seleccionar —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} {p.sku ? `(${p.sku})` : ""}
                  </option>
                ))}
              </select>
              {selectedProduct && (
                <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                  Precio base: <b>{Number(selectedProduct.base_price_usd ?? 0).toFixed(2)} USD</b>
                </div>
              )}
            </div>

            <div style={{ width: 120 }}>
              <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Qty</div>
              <input
                type="number"
                min={1}
                step={1}
                value={qty}
                onChange={(e) => setQty(Number(e.target.value))}
                style={{ width: "100%", padding: 10, borderRadius: 10 }}
                disabled={saving || !canMutateItems}
              />
            </div>

            <button
              onClick={addItem}
              disabled={saving || !canMutateItems}
              style={{
                background: saving || !canMutateItems ? "#444" : "#22c55e",
                padding: "10px 14px",
                borderRadius: 10,
                fontWeight: 900,
                color: "#111",
              }}
            >
              {!canMutateItems ? "Locked" : saving ? "Guardando…" : "Add item"}
            </button>
          </div>

          {!loading && items.length === 0 && <p style={{ marginTop: 12 }}>Este pedido no tiene items.</p>}

          {!loading && items.length > 0 && (
            <div style={{ overflowX: "auto", marginTop: 12 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1050 }}>
                <thead>
                  <tr>
                    {["#", "sku", "name", "qty", "unit", "line_total", "override", "reason", "actions"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          borderBottom: "1px solid #333",
                          padding: "10px 8px",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, idx) => {
                    const isEditing = editingItemId === it.id;

                    return (
                      <tr key={it.id}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{idx + 1}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{it.sku_snapshot ?? ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{it.product_name_snapshot}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{it.qty}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{Number(it.unit_price_usd_snapshot).toFixed(2)}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{Number(it.line_total_usd).toFixed(2)}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{it.override_unit_price_usd != null ? Number(it.override_unit_price_usd).toFixed(2) : ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{it.override_reason ?? ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                          {!isEditing ? (
                            <button
                              onClick={() => startEdit(it)}
                              disabled={saving || !canMutateItems}
                              style={{
                                padding: "6px 10px",
                                borderRadius: 8,
                                border: "none",
                                background: saving || !canMutateItems ? "#444" : "#3b82f6",
                                color: "#fff",
                                fontWeight: 800,
                              }}
                            >
                              Edit
                            </button>
                          ) : (
                            <>
                              <button onClick={() => saveItemEdit(it)} disabled={saving} style={{ marginRight: 8 }}>
                                Save
                              </button>
                              <button onClick={cancelEdit} disabled={saving}>
                                Cancel
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => deleteItem(it.id)}
                            disabled={saving || !canMutateItems}
                            style={{
                              marginLeft: 8,
                              padding: "6px 10px",
                              borderRadius: 8,
                              border: "none",
                              background: saving || !canMutateItems ? "#444" : "#ef4444",
                              color: "#fff",
                              fontWeight: 800,
                            }}
                          >
                            Delete
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}