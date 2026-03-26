"use client";

import AppShell from "@/app/app/shell";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useParams, useRouter } from "next/navigation";

type Currency = "USD" | "VES";

type MoneyAccountRow = {
  id: number;
  name: string;
  currency_code: Currency;
  account_kind: string;
  is_active: boolean;
};

export default function MasterReportPaymentForOrderPage() {
  const router = useRouter();
  const params = useParams();
  const orderId = Number(params.id);

  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [accounts, setAccounts] = useState<MoneyAccountRow[]>([]);
  const [loading, setLoading] = useState(true);

  const [moneyAccountId, setMoneyAccountId] = useState<string>("");
  const [currency, setCurrency] = useState<Currency>("VES");
  const [amount, setAmount] = useState<string>("");
  const [rate, setRate] = useState<string>("");

  const [reference, setReference] = useState<string>("");
  const [payer, setPayer] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // ---------- load accounts + auth ----------
  useEffect(() => {
    (async () => {
      setLoading(true);

      const { data: authRes } = await supabase.auth.getUser();
      if (!authRes.user) {
        router.push("/login");
        return;
      }

      const { data, error } = await supabase
        .from("money_accounts")
        .select("id, name, currency_code, account_kind, is_active")
        .eq("is_active", true)
        .order("currency_code", { ascending: true })
        .order("name", { ascending: true });

      if (error) {
        alert(error.message);
        setAccounts([]);
        setLoading(false);
        return;
      }

      setAccounts((data ?? []) as MoneyAccountRow[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // cuando cambias cuenta, ajusta moneda automáticamente
  useEffect(() => {
    const id = Number(moneyAccountId);
    if (!id) return;

    const acc = accounts.find((a) => a.id === id);
    if (!acc) return;

    setCurrency(acc.currency_code);

    // si pasa a USD, limpia tasa
    if (acc.currency_code === "USD") setRate("");
  }, [moneyAccountId, accounts]);

  function todayISO() {
    return new Date().toISOString().slice(0, 10);
  }

  async function submit() {
    if (!orderId || orderId <= 0) {
      alert("order_id inválido");
      return;
    }

    const p_reported_money_account_id = Number(moneyAccountId);
    if (!p_reported_money_account_id || p_reported_money_account_id <= 0) {
      alert("Selecciona una cuenta válida.");
      return;
    }

    const p_reported_amount = Number(amount);
    if (!Number.isFinite(p_reported_amount) || p_reported_amount <= 0) {
      alert("Monto inválido.");
      return;
    }

    let p_reported_exchange_rate_ves_per_usd: number | null = null;
    if (currency === "VES") {
      const r = Number(rate);
      if (!Number.isFinite(r) || r <= 0) {
        alert("Tasa inválida (VES/USD).");
        return;
      }
      p_reported_exchange_rate_ves_per_usd = r;
    }

    const { data: authRes } = await supabase.auth.getUser();
    if (!authRes.user) {
      router.push("/login");
      return;
    }

    const { data, error } = await supabase.rpc("create_payment_report", {
      p_order_id: orderId,
      p_reported_money_account_id,
      p_reported_currency: currency,
      p_reported_amount,
      p_reported_exchange_rate_ves_per_usd,
      p_reference_code: reference || null,
      p_payer_name: payer || null,
      p_notes: notes || null,
    });

    if (error) {
      alert(error.message);
      return;
    }

    alert(`Reporte creado. payment_report_id = ${data}`);
    router.push("/app/master/payments");
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>Master · Reportar pago</h1>
          <p style={{ opacity: 0.8, marginTop: 6 }}>
            Order ID: <b>{orderId}</b> · Fecha: <b>{todayISO()}</b>
          </p>
        </div>

        <a
          href="/app/master/payments"
          style={{
            background: "#f59e0b",
            padding: "10px 14px",
            borderRadius: 10,
            color: "black",
            fontWeight: 900,
            textDecoration: "none",
            whiteSpace: "nowrap",
          }}
        >
          ← Volver a pendientes
        </a>
      </div>

      {loading && <p>Cargando cuentas…</p>}

      {!loading && (
        <div style={{ display: "grid", gap: 10, maxWidth: 560, marginTop: 12 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Cuenta destino</div>
            <select
              value={moneyAccountId}
              onChange={(e) => setMoneyAccountId(e.target.value)}
              style={{ padding: 10, borderRadius: 10 }}
            >
              <option value="">— seleccionar —</option>
              {accounts.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.id} · {a.name} · {a.currency_code} · {a.account_kind}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Moneda (auto por cuenta)</div>
              <input
                value={currency}
                readOnly
                style={{ padding: 10, borderRadius: 10, width: 130, opacity: 0.9 }}
              />
            </label>

            <label style={{ display: "grid", gap: 6, flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 12, opacity: 0.8 }}>Monto</div>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Ej: 803.84"
                style={{ padding: 10, borderRadius: 10 }}
              />
            </label>

            {currency === "VES" && (
              <label style={{ display: "grid", gap: 6, width: 180 }}>
                <div style={{ fontSize: 12, opacity: 0.8 }}>Tasa VES/USD</div>
                <input
                  value={rate}
                  onChange={(e) => setRate(e.target.value)}
                  placeholder="Ej: 25.12"
                  style={{ padding: 10, borderRadius: 10 }}
                />
              </label>
            )}
          </div>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Referencia (opcional)</div>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Ej: ref-123"
              style={{ padding: 10, borderRadius: 10 }}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Pagador (opcional)</div>
            <input
              value={payer}
              onChange={(e) => setPayer(e.target.value)}
              placeholder="Ej: Cliente"
              style={{ padding: 10, borderRadius: 10 }}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Notas (opcional)</div>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej: pago móvil / transferencia / etc."
              style={{ padding: 10, borderRadius: 10 }}
            />
          </label>

          <button
            onClick={submit}
            style={{
              marginTop: 6,
              background: "#22c55e",
              padding: "12px 14px",
              borderRadius: 12,
              fontWeight: 900,
            }}
          >
            Reportar pago
          </button>
        </div>
      )}
    </AppShell>
  );
}