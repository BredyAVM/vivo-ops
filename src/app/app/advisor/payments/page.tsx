"use client";

import AppShell from "../../shell";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type ReportRow = {
  id: number;
  order_id: number;
  status: "pending" | "confirmed" | "rejected";
  created_at: string;

  reported_currency_code: "USD" | "VES";
  reported_amount: string | number;
  reported_amount_usd_equivalent: string | number;
  reported_exchange_rate_ves_per_usd: string | number | null;

  reference_code: string | null;
  payer_name: string | null;

  confirmed_movement_id: number | null;
  reviewed_at: string | null;
  review_notes: string | null;

  orders?: { order_number: string } | null;
};

export default function AdvisorPaymentsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);

    const { data: authRes } = await supabase.auth.getUser();
    if (!authRes.user) {
      router.push("/login");
      setLoading(false);
      return;
    }

    const { data, error } = await supabase
      .from("payment_reports")
      .select(
        `
        id,
        order_id,
        status,
        created_at,
        reported_currency_code,
        reported_amount,
        reported_amount_usd_equivalent,
        reported_exchange_rate_ves_per_usd,
        reference_code,
        payer_name,
        confirmed_movement_id,
        reviewed_at,
        review_notes,
        orders:order_id (
          order_number
        )
      `
      )
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      setRows((data ?? []) as ReportRow[]);
    }

    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function badge(status: ReportRow["status"]) {
    const map: Record<string, string> = {
      pending: "#f59e0b",
      confirmed: "#22c55e",
      rejected: "#ef4444",
    };
    return (
      <span
        style={{
          background: map[status],
          color: "black",
          fontWeight: 900,
          padding: "4px 8px",
          borderRadius: 999,
          fontSize: 12,
        }}
      >
        {status.toUpperCase()}
      </span>
    );
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>Advisor · Mis pagos reportados</h1>

        <button
          onClick={load}
          style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 800 }}
        >
          Refresh
        </button>
      </div>

      {loading && <p>Cargando…</p>}
      {error && <p style={{ color: "tomato" }}>Error: {error}</p>}
      {!loading && !error && rows.length === 0 && <p>No hay reportes.</p>}

      {!loading && !error && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["id", "order", "order_number", "status", "moneda", "monto", "usd_eq", "tasa", "ref", "pagador", "creado", "review", "movement"].map(
                  (h) => (
                    <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #333", padding: "10px 8px" }}>
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>

            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.id}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.order_id}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.orders?.order_number ?? ""}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{badge(r.status)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.reported_currency_code}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{String(r.reported_amount)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{String(r.reported_amount_usd_equivalent)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{String(r.reported_exchange_rate_ves_per_usd ?? "")}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.reference_code ?? ""}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.payer_name ?? ""}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                    {r.reviewed_at ? new Date(r.reviewed_at).toLocaleString() : ""}
                    {r.review_notes ? <div style={{ opacity: 0.8, fontSize: 12 }}>{r.review_notes}</div> : null}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                    {r.confirmed_movement_id ? String(r.confirmed_movement_id) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AppShell>
  );
}