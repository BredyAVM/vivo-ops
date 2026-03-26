"use client";

import AppShell from "../../../../shell";
import { useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useParams, useRouter } from "next/navigation";

export default function ReportPaymentForOrderPage() {
  const router = useRouter();
  const params = useParams();
  const orderId = Number(params.id);

  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [moneyAccountId, setMoneyAccountId] = useState("");
  const [currency, setCurrency] = useState<"USD" | "VES">("VES");
  const [amount, setAmount] = useState("");
  const [rate, setRate] = useState("");
  const [reference, setReference] = useState("");
  const [payer, setPayer] = useState("");
  const [notes, setNotes] = useState("");

  async function submit() {
    const p_order_id = orderId;
    const p_reported_money_account_id = Number(moneyAccountId);
    const p_reported_amount = Number(amount);

    if (!p_order_id || p_order_id <= 0) {
      alert("order_id inválido");
      return;
    }

    if (!p_reported_money_account_id || p_reported_money_account_id <= 0) {
      alert("money_account_id inválido. Usa 1 (BDV), 2 (Caja Principal) o 3 (Banco USD).");
      return;
    }

    if (!p_reported_amount || p_reported_amount <= 0) {
      alert("amount inválido");
      return;
    }

    let p_reported_exchange_rate_ves_per_usd: number | null = null;
    if (currency === "VES") {
      const r = Number(rate);
      if (!r || r <= 0) {
        alert("Tasa inválida (VES/USD)");
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
      p_order_id,
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
    router.push("/app/advisor/payments");
  }

  return (
    <AppShell>
      <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>
        Advisor · Reportar pago
      </h1>
      <p style={{ opacity: 0.8, marginTop: 6 }}>Order ID: <b>{orderId}</b></p>

      <div style={{ display: "grid", gap: 10, maxWidth: 520, marginTop: 12 }}>
        <input
          placeholder="money_account_id (1 BDV, 2 Caja, 3 USD)"
          value={moneyAccountId}
          onChange={(e) => setMoneyAccountId(e.target.value)}
          style={{ padding: 10, borderRadius: 10 }}
        />

        <select
          value={currency}
          onChange={(e) => setCurrency(e.target.value as any)}
          style={{ padding: 10, borderRadius: 10 }}
        >
          <option value="USD">USD</option>
          <option value="VES">VES</option>
        </select>

        <input
          placeholder="amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          style={{ padding: 10, borderRadius: 10 }}
        />

        {currency === "VES" && (
          <input
            placeholder="exchange rate VES/USD"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            style={{ padding: 10, borderRadius: 10 }}
          />
        )}

        <input
          placeholder="reference_code (opcional)"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          style={{ padding: 10, borderRadius: 10 }}
        />

        <input
          placeholder="payer_name (opcional)"
          value={payer}
          onChange={(e) => setPayer(e.target.value)}
          style={{ padding: 10, borderRadius: 10 }}
        />

        <input
          placeholder="notes (opcional)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={{ padding: 10, borderRadius: 10 }}
        />

        <button
          onClick={submit}
          style={{
            background: "#22c55e",
            padding: "12px 14px",
            borderRadius: 12,
            fontWeight: 900,
          }}
        >
          Reportar pago
        </button>
      </div>
    </AppShell>
  );
}