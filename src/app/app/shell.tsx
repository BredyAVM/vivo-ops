"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [roles, setRoles] = useState<string[]>([]);
  const [email, setEmail] = useState<string>("");

  useEffect(() => {
    (async () => {
      const { data: authRes } = await supabase.auth.getUser();
      if (!authRes.user) {
        router.push("/login");
        return;
      }
      setEmail(authRes.user.email ?? "");

      const { data, error } = await supabase.rpc("get_my_roles");
      if (error) {
        console.log(error);
        setRoles([]);
        return;
      }
      setRoles((data ?? []) as string[]);
    })();
  }, [router, supabase]);

  const menu = useMemo(() => {
    const isMaster = roles.includes("admin") || roles.includes("master");
    const isAdvisor = roles.includes("advisor");
    const isKitchen = roles.includes("kitchen");
    const isDriver = roles.includes("driver");

    const items: { href: string; label: string }[] = [];

    if (isMaster) {
      items.push(
        { href: "/app/master", label: "Master Home" },
        { href: "/app/master/payments", label: "Payment Reports (Pending)" },
        { href: "/app/master/delivery-partners", label: "Delivery Partners" },
        { href: "/app/master/users", label: "Users & Roles" }
      );
    }

    if (isAdvisor) {
      items.push(
        { href: "/app/advisor", label: "Advisor Home" },
        { href: "/app/advisor/orders", label: "My Orders" },
        { href: "/app/advisor/payments", label: "Mis Pagos" }
      );
    }

    if (isKitchen) items.push({ href: "/app/kitchen", label: "Kitchen Home" });
    if (isDriver) items.push({ href: "/app/driver", label: "Driver Home" });

    if (items.length === 0) items.push({ href: "/app", label: "Home" });

    return items;
  }, [roles]);

  async function logout() {
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex" }}>
      <aside style={{ width: 260, borderRight: "1px solid #222", padding: 16, background: "#0b0b0b" }}>
        <div style={{ fontWeight: 900, fontSize: 18, marginBottom: 6 }}>VIVO-OPS</div>
        <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 16 }}>
          {email || "…"}
          <br />
          Roles: {roles.length ? roles.join(", ") : "…"}
        </div>

        <nav style={{ display: "grid", gap: 10 }}>
          {menu.map((i) => (
            <Link
              key={i.href}
              href={i.href}
              style={{
                color: "white",
                textDecoration: "none",
                padding: "10px 12px",
                borderRadius: 10,
                border: "1px solid #222",
                background: "#111",
              }}
            >
              {i.label}
            </Link>
          ))}
        </nav>

        <button
          onClick={logout}
          style={{
            width: "100%",
            marginTop: 18,
            padding: "10px 12px",
            borderRadius: 10,
            background: "#ef4444",
            color: "white",
            fontWeight: 800,
          }}
        >
          Logout
        </button>
      </aside>

      <div style={{ flex: 1 }}>
        <header style={{ padding: 16, borderBottom: "1px solid #222" }}>
          <div style={{ fontWeight: 800 }}>Panel</div>
        </header>
        <main style={{ padding: 16 }}>{children}</main>
      </div>
    </div>
  );
}