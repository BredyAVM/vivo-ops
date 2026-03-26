"use client";

import AppShell from "../../shell";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type Role = "admin" | "master" | "advisor" | "kitchen" | "driver";

type ProfileRow = {
  id: string;
  full_name: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

type UserRoleRow = {
  user_id: string;
  role: Role;
};

const ALL_ROLES: Role[] = ["admin", "master", "advisor", "kitchen", "driver"];

function roleLabel(r: Role) {
  const map: Record<Role, string> = {
    admin: "Admin",
    master: "Master",
    advisor: "Asesor",
    kitchen: "Cocina",
    driver: "Motorizado",
  };
  return map[r] ?? r;
}

export default function MasterUsersPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [roles, setRoles] = useState<UserRoleRow[]>([]);
  const [q, setQ] = useState("");

  // edit modal state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string>("");
  const [editingActive, setEditingActive] = useState<boolean>(true);
  const [editingRoles, setEditingRoles] = useState<Record<Role, boolean>>({
    admin: false,
    master: false,
    advisor: false,
    kitchen: false,
    driver: false,
  });

  async function mustBeLoggedIn() {
    const { data: authRes } = await supabase.auth.getUser();
    if (!authRes.user) {
      router.push("/login");
      return false;
    }
    return true;
  }

  function rolesFor(userId: string): Role[] {
    return roles.filter((r) => r.user_id === userId).map((r) => r.role);
  }

  async function load() {
    setLoading(true);
    setError(null);

    const ok = await mustBeLoggedIn();
    if (!ok) return;

    try {
      const { data: pRows, error: pErr } = await supabase
        .from("profiles")
        .select("id, full_name, is_active, created_at")
        .order("created_at", { ascending: false })
        .limit(500);

      if (pErr) throw new Error(pErr.message);

      // roles globales vía RPC (si existe) o fallback:
      // En tu setup ya creamos admin_list_user_roles para evitar recursion.
      const { data: rRows, error: rErr } = await supabase.rpc("admin_list_user_roles");
      if (rErr) throw new Error(rErr.message);

      setProfiles((pRows ?? []) as ProfileRow[]);
      setRoles((rRows ?? []) as UserRoleRow[]);
    } catch (e: any) {
      setError(e?.message ?? "Error cargando users/roles");
      setProfiles([]);
      setRoles([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openEdit(userId: string) {
    setError(null);

    const p = profiles.find((x) => x.id === userId);
    const currentRoles = new Set(rolesFor(userId));

    setEditingUserId(userId);
    setEditingName(p?.full_name ?? "");
    setEditingActive(Boolean(p?.is_active ?? true));
    setEditingRoles({
      admin: currentRoles.has("admin"),
      master: currentRoles.has("master"),
      advisor: currentRoles.has("advisor"),
      kitchen: currentRoles.has("kitchen"),
      driver: currentRoles.has("driver"),
    });
  }

  function closeEdit() {
    setEditingUserId(null);
    setEditingName("");
    setEditingActive(true);
    setEditingRoles({
      admin: false,
      master: false,
      advisor: false,
      kitchen: false,
      driver: false,
    });
  }

  async function saveEdit() {
    if (!editingUserId) return;

    setSaving(true);
    setError(null);

    try {
      // 1) update profile
      const { error: updErr } = await supabase
        .from("profiles")
        .update({
          full_name: editingName.trim() === "" ? null : editingName.trim(),
          is_active: editingActive,
        })
        .eq("id", editingUserId);

      if (updErr) throw new Error(updErr.message);

      // 2) sync roles: delete all + insert selected
      const { error: delErr } = await supabase.from("user_roles").delete().eq("user_id", editingUserId);
      if (delErr) throw new Error(delErr.message);

      const nextRoles = ALL_ROLES.filter((r) => editingRoles[r]);
      if (nextRoles.length > 0) {
        const payload = nextRoles.map((r) => ({ user_id: editingUserId, role: r }));
        const { error: insErr } = await supabase.from("user_roles").insert(payload);
        if (insErr) throw new Error(insErr.message);
      }

      closeEdit();
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Error guardando usuario/roles");
    } finally {
      setSaving(false);
    }
  }

  const filtered = profiles.filter((p) => {
    if (!q.trim()) return true;
    const term = q.trim().toLowerCase();
    return (p.full_name ?? "").toLowerCase().includes(term) || p.id.toLowerCase().includes(term);
  });

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>Master · Users & Roles</h1>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por nombre o id…"
            style={{ padding: "10px 12px", borderRadius: 10, minWidth: 260 }}
            disabled={loading || saving}
          />

          <button
            onClick={() => router.push("/app/master/users/new")}
            disabled={saving}
            style={{ background: "#22c55e", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
          >
            + Crear
          </button>

          <button
            onClick={load}
            disabled={loading || saving}
            style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 800 }}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <p style={{ color: "tomato", marginTop: 10 }}>Error: {error}</p>}
      {loading && <p style={{ marginTop: 10 }}>Cargando…</p>}

      {!loading && (
        <section style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Usuarios ({filtered.length})</div>

          {filtered.length === 0 ? (
            <p>No hay usuarios.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1000 }}>
                <thead>
                  <tr>
                    {["id", "nombre", "activo", "roles", "creado", "acciones"].map((h) => (
                      <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #333", padding: "10px 8px" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => {
                    const rs = rolesFor(p.id);
                    return (
                      <tr key={p.id}>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222", fontFamily: "monospace" }}>{p.id}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{p.full_name ?? ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{Boolean(p.is_active ?? true) ? "✅" : "—"}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{rs.length ? rs.map(roleLabel).join(", ") : "—"}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{p.created_at ? new Date(p.created_at).toLocaleString() : ""}</td>
                        <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                          <button
                            onClick={() => openEdit(p.id)}
                            disabled={saving}
                            style={{ background: "#22c55e", padding: "8px 10px", borderRadius: 10, fontWeight: 900 }}
                          >
                            Editar
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

      {editingUserId && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 50,
          }}
        >
          <div style={{ width: "min(820px, 100%)", background: "#0b0b0b", border: "1px solid #222", borderRadius: 14, padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900, fontSize: 18 }}>Editar usuario</div>
              <button onClick={closeEdit} disabled={saving} style={{ background: "#444", padding: "8px 10px", borderRadius: 10, color: "white", fontWeight: 900 }}>
                Cerrar
              </button>
            </div>

            <div style={{ marginTop: 10, opacity: 0.8, fontFamily: "monospace", fontSize: 12 }}>{editingUserId}</div>

            <div style={{ marginTop: 12, display: "grid", gap: 10, gridTemplateColumns: "1.3fr 0.7fr" }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Nombre</div>
                <input value={editingName} onChange={(e) => setEditingName(e.target.value)} style={{ width: "100%", padding: 10, borderRadius: 10 }} disabled={saving} />
              </div>

              <div style={{ display: "flex", alignItems: "end" }}>
                <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 800 }}>
                  <input type="checkbox" checked={editingActive} onChange={(e) => setEditingActive(e.target.checked)} disabled={saving} />
                  Activo
                </label>
              </div>
            </div>

            <div style={{ marginTop: 14, fontWeight: 900 }}>Roles</div>
            <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
              {ALL_ROLES.map((r) => (
                <label key={r} style={{ display: "flex", gap: 10, alignItems: "center", border: "1px solid #222", borderRadius: 12, padding: 10 }}>
                  <input type="checkbox" checked={editingRoles[r]} onChange={(e) => setEditingRoles((prev) => ({ ...prev, [r]: e.target.checked }))} disabled={saving} />
                  {roleLabel(r)}
                </label>
              ))}
            </div>

            <div style={{ marginTop: 14, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={saveEdit} disabled={saving} style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 900 }}>
                {saving ? "Guardando…" : "Guardar cambios"}
              </button>
              <button onClick={closeEdit} disabled={saving} style={{ background: "#444", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 900 }}>
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}