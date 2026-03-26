"use client";

import AppShell from "@/app/app/shell";
import { useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type UserRole = "admin" | "master" | "advisor" | "kitchen" | "driver";

const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin",
  master: "Master",
  advisor: "Asesor",
  kitchen: "Cocina",
  driver: "Motorizado",
};

export default function MasterCreateUserPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fullName, setFullName] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [roles, setRoles] = useState<UserRole[]>(["advisor"]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleRole(role: UserRole) {
    setRoles((prev) => (prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]));
  }

  async function createUser() {
    setError(null);

    const e = email.trim().toLowerCase();
    if (!e || !e.includes("@")) return setError("Email inválido.");
    if (!password || password.length < 6) return setError("Password mínimo 6 caracteres.");
    if (!fullName.trim()) return setError("Nombre obligatorio.");
    if (roles.length === 0) return setError("Selecciona al menos 1 rol.");

    setSaving(true);
    try {
      const { data: sessionRes } = await supabase.auth.getSession();
      const accessToken = sessionRes.session?.access_token;
      if (!accessToken) {
        router.push("/login");
        return;
      }

      const res = await fetch("/api/admin/create-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accessToken,
          email: e,
          password,
          full_name: fullName.trim(),
          is_active: isActive,
          roles,
        }),
      });

      const json = await res.json();

      if (!res.ok) {
        setError(json?.error ?? "Error creando usuario.");
        return;
      }

      router.push("/app/master/users");
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Error inesperado.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 26, fontWeight: 900, margin: 0 }}>Master · Crear usuario</h1>

        <button
          onClick={() => router.push("/app/master/users")}
          style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #333", background: "transparent", color: "white", fontWeight: 800 }}
        >
          ← Volver
        </button>
      </div>

      <div style={{ marginTop: 14, maxWidth: 720, border: "1px solid #222", borderRadius: 12, padding: 14, background: "#0b0b0b" }}>
        {error && (
          <div style={{ padding: 12, borderRadius: 10, border: "1px solid #7f1d1d", background: "#3a1515", color: "#fecaca", marginBottom: 12 }}>
            {error}
          </div>
        )}

        <div style={{ display: "grid", gap: 10 }}>
          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ opacity: 0.8 }}>Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ej: driver1@vivo.local"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #333", background: "#111", color: "white" }}
              disabled={saving}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ opacity: 0.8 }}>Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="mínimo 6 caracteres"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #333", background: "#111", color: "white" }}
              disabled={saving}
            />
          </label>

          <label style={{ display: "grid", gap: 6 }}>
            <span style={{ opacity: 0.8 }}>Nombre (full_name)</span>
            <input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Ej: Driver 1"
              style={{ padding: "10px 12px", borderRadius: 10, border: "1px solid #333", background: "#111", color: "white" }}
              disabled={saving}
            />
          </label>

          <label style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} disabled={saving} />
            <span>Activo</span>
          </label>

          <div style={{ marginTop: 6 }}>
            <div style={{ opacity: 0.85, marginBottom: 8, fontWeight: 900 }}>Roles</div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {(["admin", "master", "advisor", "kitchen", "driver"] as UserRole[]).map((r) => {
                const on = roles.includes(r);
                return (
                  <button
                    key={r}
                    onClick={() => toggleRole(r)}
                    type="button"
                    disabled={saving}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 999,
                      border: "1px solid #333",
                      background: on ? "#22c55e" : "#111",
                      color: on ? "#111" : "white",
                      fontWeight: 900,
                      cursor: saving ? "not-allowed" : "pointer",
                    }}
                  >
                    {ROLE_LABEL[r]}
                  </button>
                );
              })}
            </div>
          </div>

          <button
            onClick={createUser}
            disabled={saving}
            style={{
              marginTop: 12,
              padding: "12px 14px",
              borderRadius: 12,
              border: "none",
              background: saving ? "#444" : "#3b82f6",
              color: "white",
              fontWeight: 900,
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Creando..." : "Crear usuario"}
          </button>
        </div>
      </div>
    </AppShell>
  );
}