"use client";

import AppShell from "../../shell";
import { useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type PartnerType = "direct_driver" | "company_dispatch";

type DeliveryPartnerRow = {
  id: number;
  name: string;
  partner_type: PartnerType;
  whatsapp_phone: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
};

export default function MasterDeliveryPartnersPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [rows, setRows] = useState<DeliveryPartnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // form
  const [name, setName] = useState("");
  const [partnerType, setPartnerType] = useState<PartnerType>("company_dispatch");
  const [whatsapp, setWhatsapp] = useState("");
  const [notes, setNotes] = useState("");
  const [isActive, setIsActive] = useState(true);

  // edit mode
  const [editingId, setEditingId] = useState<number | null>(null);

  async function mustBeLoggedIn() {
    const { data: authRes } = await supabase.auth.getUser();
    if (!authRes.user) {
      router.push("/login");
      return false;
    }
    return true;
  }

  async function load() {
    setLoading(true);
    setError(null);

    const ok = await mustBeLoggedIn();
    if (!ok) return;

    const { data, error } = await supabase
      .from("delivery_partners")
      .select("id, name, partner_type, whatsapp_phone, notes, is_active, created_at")
      .order("is_active", { ascending: false })
      .order("name", { ascending: true });

    if (error) {
      setError(error.message);
      setRows([]);
    } else {
      setRows((data ?? []) as DeliveryPartnerRow[]);
    }

    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function resetForm() {
    setEditingId(null);
    setName("");
    setPartnerType("company_dispatch");
    setWhatsapp("");
    setNotes("");
    setIsActive(true);
  }

  function startEdit(r: DeliveryPartnerRow) {
    setEditingId(r.id);
    setName(r.name);
    setPartnerType(r.partner_type);
    setWhatsapp(r.whatsapp_phone ?? "");
    setNotes(r.notes ?? "");
    setIsActive(Boolean(r.is_active));
  }

  async function save() {
    setError(null);

    const n = name.trim();
    if (!n) {
      setError("Nombre es obligatorio.");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        name: n,
        partner_type: partnerType,
        whatsapp_phone: whatsapp.trim() === "" ? null : whatsapp.trim(),
        notes: notes.trim() === "" ? null : notes.trim(),
        is_active: isActive,
      };

      if (editingId == null) {
        const { error } = await supabase.from("delivery_partners").insert(payload);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await supabase
          .from("delivery_partners")
          .update(payload)
          .eq("id", editingId);
        if (error) throw new Error(error.message);
      }

      resetForm();
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Error guardando partner");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(r: DeliveryPartnerRow) {
    setError(null);
    setSaving(true);
    try {
      const { error } = await supabase
        .from("delivery_partners")
        .update({ is_active: !r.is_active })
        .eq("id", r.id);

      if (error) throw new Error(error.message);
      await load();
    } catch (e: any) {
      setError(e?.message ?? "Error cambiando estado");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppShell>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 24, fontWeight: 900, margin: 0 }}>Master · Delivery Partners</h1>
        <button
          onClick={load}
          disabled={loading || saving}
          style={{ background: "#3b82f6", padding: "10px 14px", borderRadius: 10, color: "white", fontWeight: 800 }}
        >
          Refresh
        </button>
      </div>

      {error && <p style={{ color: "tomato", marginTop: 10 }}>Error: {error}</p>}
      {loading && <p style={{ marginTop: 10 }}>Cargando…</p>}

      {/* Form */}
      <section style={{ marginTop: 14, padding: 14, border: "1px solid #222", borderRadius: 12, background: "#0b0b0b" }}>
        <div style={{ fontWeight: 900, marginBottom: 10 }}>
          {editingId == null ? "Crear partner" : `Editar partner #${editingId}`}
        </div>

        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1.2fr 0.8fr 1fr" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Nombre *</div>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej: Delivery Express"
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
              disabled={saving}
            />
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Tipo</div>
            <select
              value={partnerType}
              onChange={(e) => setPartnerType(e.target.value as PartnerType)}
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
              disabled={saving}
            >
              <option value="company_dispatch">company_dispatch (empresa)</option>
              <option value="direct_driver">direct_driver (motorizado directo)</option>
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>WhatsApp (opcional)</div>
            <input
              value={whatsapp}
              onChange={(e) => setWhatsapp(e.target.value)}
              placeholder="+58..."
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
              disabled={saving}
            />
          </div>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 10, gridTemplateColumns: "1fr 160px" }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>Notas (opcional)</div>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Ej: zona, tarifa, observaciones..."
              style={{ width: "100%", padding: 10, borderRadius: 10 }}
              disabled={saving}
            />
          </div>

          <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setIsActive(e.target.checked)}
                disabled={saving}
              />
              Activo
            </label>
          </div>
        </div>

        <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button
            onClick={save}
            disabled={saving}
            style={{ background: "#22c55e", padding: "10px 14px", borderRadius: 10, fontWeight: 900 }}
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>

          <button
            onClick={resetForm}
            disabled={saving}
            style={{ background: "#444", padding: "10px 14px", borderRadius: 10, fontWeight: 900, color: "white" }}
          >
            Limpiar
          </button>
        </div>
      </section>

      {/* List */}
      {!loading && (
        <section style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, marginBottom: 10 }}>Listado</div>

          {rows.length === 0 ? (
            <p>No hay partners todavía.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
                <thead>
                  <tr>
                    {["id", "name", "partner_type", "whatsapp", "active", "created", "acciones"].map((h) => (
                      <th key={h} style={{ textAlign: "left", borderBottom: "1px solid #333", padding: "10px 8px" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.id}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.name}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.partner_type}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.whatsapp_phone ?? ""}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>{r.is_active ? "✅" : "—"}</td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                        {new Date(r.created_at).toLocaleString()}
                      </td>
                      <td style={{ padding: "10px 8px", borderBottom: "1px solid #222" }}>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            onClick={() => startEdit(r)}
                            disabled={saving}
                            style={{ background: "#3b82f6", padding: "8px 10px", borderRadius: 10, color: "white", fontWeight: 900 }}
                          >
                            Editar
                          </button>
                          <button
                            onClick={() => toggleActive(r)}
                            disabled={saving}
                            style={{ background: r.is_active ? "#ef4444" : "#22c55e", padding: "8px 10px", borderRadius: 10, color: "white", fontWeight: 900 }}
                          >
                            {r.is_active ? "Desactivar" : "Activar"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </AppShell>
  );
}