"use client";

import AppShell from "../../shell";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type PaymentReportRow = {
  id: number;
  order_id: number;
  status: string;
  created_at: string;
  created_by_user_id: string;

  reported_currency_code: "USD" | "VES";
  reported_amount: string | number;
  reported_exchange_rate_ves_per_usd: string | number | null;
  reported_amount_usd_equivalent: string | number;

  reported_money_account_id: number | null;
  reference_code: string | null;
  payer_name: string | null;
  notes: string | null;

  orders?: { order_number: string } | null;
};

type MoneyAccountRow = {
  id: number;
  name: string;
  currency_code: "USD" | "VES";
  account_kind: string;
  is_active: boolean;
};

type ConfirmDraft = {
  accountId: string; // dropdown value
  amount: string;
  movementDate: string;
  exchangeRate: string; // only used if VES
  reviewNotes: string;
  referenceCode: string;
  counterpartyName: string;
  description: string;
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function num(v: any) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export default function MasterPaymentReportsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [rows, setRows] = useState<PaymentReportRow[]>([]);
  const [accounts, setAccounts] = useState<MoneyAccountRow[]>([]);
  const [drafts, setDrafts] = useState<Record<number, ConfirmDraft>>({});

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------- Helpers ----------
  function getAccountById(id: number | null | undefined) {
    if (!id) return null;
    return accounts.find((a) => a.id === id) ?? null;
  }

  function accountLabel(a: MoneyAccountRow) {
    return `${a.id} · ${a.name} · ${a.currency_code} · ${a.account_kind}`;
  }

  function ensureDraft(r: PaymentReportRow) {
    setDrafts((prev) => {
      if (prev[r.id]) return prev;

      const defaultAccountId =
        r.reported_money_account_id != null ? String(r.reported_money_account_id) : "";

      const d: ConfirmDraft = {
        accountId: defaultAccountId,
        amount: String(r.reported_amount ?? ""),
        movementDate: todayISO(),
        exchangeRate: String(r.reported_exchange_rate_ves_per_usd ?? ""),
        reviewNotes: "Verificado",
        referenceCode: r.reference_code ?? "",
        counterpartyName: r.payer_name ?? "",
        description: r.notes ?? "",
      };

      return { ...prev, [r.id]: d };
    });
  }

  function updateDraft(reportId: number, patch: Partial<ConfirmDraft>) {
    setDrafts((prev) => ({
      ...prev,
      [reportId]: { ...(prev[reportId] ?? ({} as ConfirmDraft)), ...patch },
    }));
  }

  function validateDraft(reportId: number, d: ConfirmDraft, account: MoneyAccountRow | null) {
    if (!d?.movementDate || d.movementDate.length !== 10) return "movement_date inválida (YYYY-MM-DD)";
    const accountIdNum = Number(d.accountId);
    if (!accountIdNum || accountIdNum <= 0) return "Selecciona una cuenta válida";
    if (!account) return "Cuenta no encontrada";

    const amount = Number(d.amount);
    if (!Number.isFinite(amount) || amount <= 0) return "Monto inválido";

    if (account.currency_code === "VES") {
      const rate = Number(d.exchangeRate);
      if (!Number.isFinite(rate) || rate <= 0) return "Tasa inválida (VES/USD)";
    }
    return null;
  }

  // ---------- Loads ----------
  async function authGuard() {
    const { data: authRes } = await supabase.auth.getUser();
    if (!authRes.user) {
      router.push("/login");
      return false;
    }
    return true;
  }

  async function loadAccountsOnce() {
    if (accounts.length > 0) return; // keep in memory

    const res = await supabase
      .from("money_accounts")
      .select("id, name, currency_code, account_kind, is_active")
      .eq("is_active", true)
      .order("currency_code", { ascending: true })
      .order("name", { ascending: true });

    if (res.error) throw new Error(res.error.message);

    setAccounts((res.data ?? []) as MoneyAccountRow[]);
  }

  async function loadPendingRows() {
    const res = await supabase
      .from("payment_reports")
      .select(
        `
        id,
        order_id,
        status,
        created_at,
        created_by_user_id,
        reported_currency_code,
        reported_amount,
        reported_exchange_rate_ves_per_usd,
        reported_amount_usd_equivalent,
        reported_money_account_id,
        reference_code,
        payer_name,
        notes,
        orders:order_id (
          order_number
        )
      `
      )
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(50);

    if (res.error) throw new Error(res.error.message);

    const pending = (res.data ?? []) as PaymentReportRow[];
    setRows(pending);
    pending.forEach((r) => ensureDraft(r));
  }

  async function initialLoad() {
    setLoading(true);
    setError(null);

    try {
      const ok = await authGuard();
      if (!ok) return;

      await Promise.all([loadAccountsOnce(), loadPendingRows()]);
    } catch (e: any) {
      setError(e?.message ?? "Error cargando data");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function refreshPendingOnly() {
    setRefreshing(true);
    setError(null);
    try {
      const ok = await authGuard();
      if (!ok) return;

      await loadPendingRows();
    } catch (e: any) {
      setError(e?.message ?? "Error refrescando pendientes");
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    initialLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- Metrics (B) ----------
  const metrics = useMemo(() => {
    const pendingCount = rows.length;
    const pendingUsdEq = rows.reduce((acc, r) => acc + num(r.reported_amount_usd_equivalent), 0);

    const pendingUsdReported = rows
      .filter((r) => r.reported_currency_code === "USD")
      .reduce((acc, r) => acc + num(r.reported_amount), 0);

    const pendingVesReported = rows
      .filter((r) => r.reported_currency_code === "VES")
      .reduce((acc, r) => acc + num(r.reported_amount), 0);

    return {
      pendingCount,
      pendingUsdEq,
      pendingUsdReported,
      pendingVesReported,
    };
  }, [rows]);

  // ---------- Actions ----------
  function optimisticRemove(reportId: number) {
    setRows((prev) => prev.filter((x) => x.id !== reportId));
    setDrafts((prev) => {
      const copy = { ...prev };
      delete copy[reportId];
      return copy;
    });
  }

  async function confirm(r: PaymentReportRow) {
    const d = drafts[r.id];
    if (!d) {
      alert("Draft no inicializado. Refresca.");
      return;
    }

    const accountIdNum = Number(d.accountId);
    const account = getAccountById(accountIdNum);

    const errMsg = validateDraft(r.id, d, account);
    if (errMsg) {
      alert(errMsg);
      return;
    }

    const currency = account!.currency_code as "USD" | "VES";
    const amount = Number(d.amount);
    const exchangeRate = currency === "VES" ? Number(d.exchangeRate) : null;

    // optimistic UI
    optimisticRemove(r.id);

    const { data, error } = await supabase.rpc("confirm_payment_report", {
      p_report_id: r.id,
      p_confirmed_money_account_id: accountIdNum,
      p_confirmed_currency: currency,
      p_confirmed_amount: amount,
      p_movement_date: d.movementDate,
      p_confirmed_exchange_rate_ves_per_usd: exchangeRate,
      p_review_notes: d.reviewNotes || "Verificado",
      p_reference_code: d.referenceCode || null,
      p_counterparty_name: d.counterpartyName || null,
      p_description: d.description || null,
    });

    if (error) {
      // rollback (simple: refresh pendings)
      alert(error.message);
      await refreshPendingOnly();
      return;
    }

    alert(`Confirmado. movement_id = ${data}`);
  }

  async function reject(r: PaymentReportRow) {
    const review_notes = prompt("Motivo de rechazo:", "No verificado / datos inconsistentes");
    if (!review_notes) return;

    // optimistic UI
    optimisticRemove(r.id);

    const { error } = await supabase.rpc("reject_payment_report", {
      p_report_id: r.id,
      p_review_notes: review_notes,
    });

    if (error) {
      alert(error.message);
      await refreshPendingOnly();
      return;
    }

    alert("Rechazado.");
  }

  // A3: Confirmación rápida (1 click)
  async function quickConfirm(r: PaymentReportRow) {
    // Precondiciones: necesita cuenta reportada válida
    if (!r.reported_money_account_id) {
      alert("Este reporte no tiene cuenta reportada. Selecciona una cuenta primero.");
      return;
    }
    const account = getAccountById(r.reported_money_account_id);
    if (!account) {
      alert("Cuenta reportada no existe o no está activa. Selecciona una cuenta.");
      return;
    }

    // Construimos draft rápido
    const currency = account.currency_code;
    const amount = num(r.reported_amount);

    if (amount <= 0) {
      alert("Monto reportado inválido.");
      return;
    }

    if (currency === "VES") {
      const rate = num(r.reported_exchange_rate_ves_per_usd);
      if (rate <= 0) {
        alert("Falta tasa en el reporte. Colócala en el panel antes de confirmar.");
        return;
      }
    }

    // optimistic UI
    optimisticRemove(r.id);

    const { data, error } = await supabase.rpc("confirm_payment_report", {
      p_report_id: r.id,
      p_confirmed_money_account_id: r.reported_money_account_id,
      p_confirmed_currency: currency,
      p_confirmed_amount: amount,
      p_movement_date: todayISO(),
      p_confirmed_exchange_rate_ves_per_usd: currency === "VES" ? num(r.reported_exchange_rate_ves_per_usd) : null,
      p_review_notes: "Verificado",
      p_reference_code: r.reference_code || null,
      p_counterparty_name: r.payer_name || null,
      p_description: r.notes || null,
    });

    if (error) {
      alert(error.message);
      await refreshPendingOnly();
      return;
    }

    alert(`Confirmado rápido. movement_id = ${data}`);
  }

  // Enter-to-confirm (A2)
  function handleEnterConfirm(e: React.KeyboardEvent, report: PaymentReportRow) {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm(report);
    }
  }

  return (
    <AppShell>
      {/* Header + Metrics */}
      <div style={{ display: "grid", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>Master · Payment Reports (Pending)</h1>

          <button
            onClick={refreshPendingOnly}
            disabled={refreshing || loading}
            style={{
              background: refreshing || loading ? "#334155" : "#3b82f6",
              padding: "10px 14px",
              borderRadius: 10,
              color: "white",
              fontWeight: 800,
              cursor: refreshing || loading ? "not-allowed" : "pointer",
            }}
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        <div
          style={{
            display: "flex",
            gap: 12,
            flexWrap: "wrap",
            padding: 12,
            border: "1px solid #222",
            borderRadius: 10,
            background: "#0f0f0f",
          }}
        >
          <div>🧾 Pendings: <b>{metrics.pendingCount}</b></div>
          <div>💵 Pending USD eq: <b>{metrics.pendingUsdEq.toFixed(2)}</b></div>
          <div>🇺🇸 Pending USD (reported): <b>{metrics.pendingUsdReported.toFixed(2)}</b></div>
          <div>🇻🇪 Pending VES (reported): <b>{metrics.pendingVesReported.toFixed(2)}</b></div>
        </div>
      </div>

      {loading && <p>Cargando…</p>}
      {error && <p style={{ color: "tomato" }}>Error: {error}</p>}
      {!loading && !error && rows.length === 0 && <p>No hay reportes pendientes.</p>}

      {!loading && !error && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {[
                  "id",
                  "order_id",
                  "order_number",
                  "reporte",
                  "usd_eq",
                  "creado",
                  "ver pedido",
                  "confirmación (inline)",
                  "acciones",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #333",
                      padding: "10px 8px",
                      verticalAlign: "bottom",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => {
                const d = drafts[r.id];
                const selectedAccountId = d?.accountId ? Number(d.accountId) : null;
                const selectedAccount = selectedAccountId ? getAccountById(selectedAccountId) : null;

                return (
                  <tr key={r.id}>
                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      {r.id}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      {r.order_id}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      {r.orders?.order_number ?? ""}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      <div style={{ fontWeight: 800 }}>
                        {r.reported_currency_code} {String(r.reported_amount)}
                      </div>
                      <div style={{ opacity: 0.8, fontSize: 12 }}>
                        tasa: {String(r.reported_exchange_rate_ves_per_usd ?? "")} · cuenta:{" "}
                        {String(r.reported_money_account_id ?? "")}
                      </div>
                      <div style={{ opacity: 0.8, fontSize: 12 }}>
                        ref: {r.reference_code ?? ""} · pagador: {r.payer_name ?? ""}
                      </div>
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      {String(r.reported_amount_usd_equivalent)}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      {new Date(r.created_at).toLocaleString()}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      <a href={`/orders/${r.order_id}`} style={{ color: "#60a5fa" }}>
                        Ver pedido
                      </a>
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", minWidth: 460, verticalAlign: "top" }}>
                      {!d ? (
                        <button
                          onClick={() => ensureDraft(r)}
                          style={{
                            background: "#111",
                            padding: "8px 10px",
                            borderRadius: 10,
                            color: "white",
                            border: "1px solid #222",
                          }}
                        >
                          Preparar confirmación
                        </button>
                      ) : (
                        <div style={{ display: "grid", gap: 8 }}>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input
                              value={d.movementDate}
                              onChange={(e) => updateDraft(r.id, { movementDate: e.target.value })}
                              placeholder="YYYY-MM-DD"
                              style={{ padding: "8px 10px", borderRadius: 10, width: 140 }}
                              onKeyDown={(e) => handleEnterConfirm(e, r)}
                            />

                            <select
                              value={d.accountId}
                              onChange={(e) => {
                                const newId = e.target.value;
                                const acc = getAccountById(Number(newId));
                                updateDraft(r.id, {
                                  accountId: newId,
                                  // si cambia a VES, precargar tasa (reportada o la que tenga el draft)
                                  exchangeRate:
                                    acc?.currency_code === "VES"
                                      ? (d.exchangeRate || String(r.reported_exchange_rate_ves_per_usd ?? ""))
                                      : "",
                                });
                              }}
                              style={{ padding: "8px 10px", borderRadius: 10, minWidth: 260 }}
                            >
                              <option value="">— Cuenta destino —</option>
                              {accounts.map((a) => (
                                <option key={a.id} value={String(a.id)}>
                                  {accountLabel(a)}
                                </option>
                              ))}
                            </select>

                            <input
                              value={d.amount}
                              onChange={(e) => updateDraft(r.id, { amount: e.target.value })}
                              placeholder="Monto"
                              style={{ padding: "8px 10px", borderRadius: 10, width: 120 }}
                              onKeyDown={(e) => handleEnterConfirm(e, r)}
                            />

                            {selectedAccount?.currency_code === "VES" && (
                              <input
                                value={d.exchangeRate}
                                onChange={(e) => updateDraft(r.id, { exchangeRate: e.target.value })}
                                placeholder="Tasa"
                                style={{ padding: "8px 10px", borderRadius: 10, width: 120 }}
                                onKeyDown={(e) => handleEnterConfirm(e, r)}
                              />
                            )}
                          </div>

                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input
                              value={d.referenceCode}
                              onChange={(e) => updateDraft(r.id, { referenceCode: e.target.value })}
                              placeholder="Referencia"
                              style={{ padding: "8px 10px", borderRadius: 10, width: 160 }}
                              onKeyDown={(e) => handleEnterConfirm(e, r)}
                            />

                            <input
                              value={d.counterpartyName}
                              onChange={(e) => updateDraft(r.id, { counterpartyName: e.target.value })}
                              placeholder="Pagador"
                              style={{ padding: "8px 10px", borderRadius: 10, width: 160 }}
                              onKeyDown={(e) => handleEnterConfirm(e, r)}
                            />

                            <input
                              value={d.reviewNotes}
                              onChange={(e) => updateDraft(r.id, { reviewNotes: e.target.value })}
                              placeholder="Notas verificación"
                              style={{ padding: "8px 10px", borderRadius: 10, flex: 1, minWidth: 180 }}
                              onKeyDown={(e) => handleEnterConfirm(e, r)}
                            />
                          </div>

                          <input
                            value={d.description}
                            onChange={(e) => updateDraft(r.id, { description: e.target.value })}
                            placeholder="Descripción / notas (opcional)"
                            style={{ padding: "8px 10px", borderRadius: 10 }}
                            onKeyDown={(e) => handleEnterConfirm(e, r)}
                          />

                          <div style={{ opacity: 0.75, fontSize: 12 }}>
                            Moneda confirmación: <b>{selectedAccount?.currency_code ?? "—"}</b>
                            {selectedAccount?.currency_code === "VES" ? " (tasa obligatoria)" : ""}
                          </div>
                        </div>
                      )}
                    </td>

                    <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", verticalAlign: "top" }}>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button
                          onClick={() => confirm(r)}
                          style={{
                            background: "#22c55e",
                            padding: "8px 10px",
                            borderRadius: 10,
                            fontWeight: 900,
                          }}
                        >
                          Confirmar
                        </button>

                        <button
                          onClick={() => quickConfirm(r)}
                          style={{
                            background: "#10b981",
                            padding: "8px 10px",
                            borderRadius: 10,
                            fontWeight: 900,
                          }}
                        >
                          ⚡ Confirmar rápido
                        </button>

                        <button
                          onClick={() => reject(r)}
                          style={{
                            background: "#ef4444",
                            padding: "8px 10px",
                            borderRadius: 10,
                            fontWeight: 900,
                          }}
                        >
                          Rechazar
                        </button>
                      </div>

                      <div style={{ marginTop: 8, opacity: 0.75, fontSize: 12 }}>
                        Tip: el rápido usa valores reportados (cuenta/monto/tasa) + fecha hoy.
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}