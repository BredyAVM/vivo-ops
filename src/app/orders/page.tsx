"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowser } from "@/lib/supabase";

type OrderRow = {
  id: number;
  order_number: string;
  status: string;
  fulfillment: string;
  source: string;
  total_usd: string | number;
  created_at: string;
};

export default function OrdersPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);

    const { data: authRes, error: authErr } = await supabase.auth.getUser();

    if (authErr) {
      setError(authErr.message);
      setLoading(false);
      return;
    }

    if (!authRes.user) {
      router.push("/login");
      setLoading(false);
      return;
    }

    const { data: rolesData, error: rolesError } = await supabase.rpc("get_my_roles");

    if (rolesError) {
      setError(rolesError.message);
      setLoading(false);
      return;
    }

    const roles = Array.isArray(rolesData) ? rolesData : [];
    if (roles.includes("advisor")) {
      router.replace("/app/advisor/orders");
      setLoading(false);
      return;
    }

    const { data, error: ordersError } = await supabase
      .from("orders")
      .select("id, order_number, status, fulfillment, source, total_usd, created_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (ordersError) {
      setError(ordersError.message);
      setOrders([]);
    } else {
      setOrders((data ?? []) as OrderRow[]);
    }

    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function logout() {
    const { error: logoutError } = await supabase.auth.signOut();
    if (logoutError) {
      setError(logoutError.message);
      return;
    }

    router.push("/login");
    router.refresh();
  }

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, margin: 0 }}>Orders</h1>

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => void load()}
            style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 800 }}
          >
            Refresh
          </button>

          <Link
            href="/orders/new"
            style={{
              background: "#22c55e",
              padding: "10px 14px",
              borderRadius: 10,
              color: "white",
              textDecoration: "none",
              fontWeight: 900,
            }}
          >
            + Nueva orden
          </Link>

          <button
            onClick={logout}
            style={{ background: "#ef4444", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 800 }}
          >
            Logout
          </button>
        </div>
      </div>

      <p style={{ opacity: 0.7, marginTop: 10 }}>
        Lista simple conectada a Supabase (tabla <b>orders</b>)
      </p>

      {loading && <p>Cargando...</p>}

      {error && (
        <p style={{ color: "tomato" }}>
          Error: {error}
          <br />
          (Auth / RLS / env, etc.)
        </p>
      )}

      {!loading && !error && orders.length === 0 && <p>No hay ordenes todavia.</p>}

      {!loading && !error && orders.length > 0 && (
        <div style={{ marginTop: 16, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                {["#", "order_number", "status", "fulfillment", "source", "total_usd", "created_at", "ver"].map((h) => (
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
              {orders.map((order, idx) => (
                <tr key={order.id}>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{idx + 1}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{order.order_number}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{order.status}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{order.fulfillment}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{order.source}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{String(order.total_usd)}</td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                    {new Date(order.created_at).toLocaleString()}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                    <Link href={`/orders/${order.id}`} style={{ color: "#60a5fa" }}>
                      Ver
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
