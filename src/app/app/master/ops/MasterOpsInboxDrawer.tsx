"use client";

import { useEffect, useMemo, useState } from "react";
import { formatOrderDisplayNumber } from "@/lib/orders/order-labels";
import { formatMasterOrderDateTime } from "../_components/MasterOrderDetailCore";
import {
  loadMasterOpsInboxAction,
  markMasterOpsInboxItemsReviewedAction,
  reopenMasterOpsInboxItemsAction,
  type MasterOpsInboxCategory,
  type MasterOpsInboxItem,
  type MasterOpsInboxKind,
  type MasterOpsInboxStateItemInput,
} from "./inbox-actions";

type StatusFilter = "open" | "reviewed" | "resolved" | "all";
type CategoryFilter = "all" | MasterOpsInboxCategory;

type Props = {
  kind: MasterOpsInboxKind;
  onClose: () => void;
  onOpenOrder: (item: MasterOpsInboxItem) => void;
  onCountChange: (kind: MasterOpsInboxKind, count: number) => void;
};

const categoryOptions: Array<{ key: CategoryFilter; label: string }> = [
  { key: "all", label: "Todo" },
  { key: "payments", label: "Pagos" },
  { key: "changes", label: "Cambios" },
  { key: "kitchen", label: "Cocina" },
  { key: "delivery", label: "Entrega" },
  { key: "approval", label: "Aprobación" },
];

const statusOptions: Array<{ key: StatusFilter; label: string }> = [
  { key: "open", label: "Pendientes" },
  { key: "reviewed", label: "Leídas" },
  { key: "resolved", label: "Cerradas" },
  { key: "all", label: "Todas" },
];

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      className={[
        "rounded-full border px-2.5 py-1 text-[11px] font-medium transition",
        active
          ? "border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]"
          : "border-[#242433] bg-[#0B0B0D] text-[#B7B7C2] hover:border-[#FEEF00]/40 hover:text-[#F5F5F7]",
      ].join(" ")}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function Badge({ label, tone = "muted" }: { label: string; tone?: "brand" | "warn" | "danger" | "muted" }) {
  const toneClass =
    tone === "brand"
      ? "border-[#FEEF00]/45 bg-[#FEEF00]/10 text-[#FEEF00]"
      : tone === "danger"
        ? "border-red-500/45 bg-red-500/10 text-red-200"
        : tone === "warn"
          ? "border-orange-400/40 bg-orange-400/10 text-orange-200"
          : "border-[#2C3142] bg-[#101014] text-[#8A8A96]";

  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${toneClass}`}>{label}</span>;
}

function statusMatches(item: MasterOpsInboxItem, filter: StatusFilter) {
  if (filter === "all") return true;
  if (filter === "open") return item.status == null;
  return item.status === filter;
}

function stateInput(item: MasterOpsInboxItem): MasterOpsInboxStateItemInput {
  return { itemId: item.id, itemType: "event", orderId: item.orderId };
}

export default function MasterOpsInboxDrawer({ kind, onClose, onOpenOrder, onCountChange }: Props) {
  const [items, setItems] = useState<MasterOpsInboxItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [savingIds, setSavingIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    loadMasterOpsInboxAction({ kind, limit: kind === "actions" ? 40 : 50 })
      .then((payload) => {
        if (cancelled) return;
        setItems(payload.items);
        onCountChange(kind, payload.openCount);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setItems([]);
        setError(loadError instanceof Error ? loadError.message : "No se pudo cargar la bandeja.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [kind, onCountChange, reloadVersion]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (kind === "actions") return true;
      const categoryMatches = categoryFilter === "all" || item.category === categoryFilter;
      return categoryMatches && statusMatches(item, statusFilter);
    });
  }, [categoryFilter, items, kind, statusFilter]);

  const reviewableFilteredItems = useMemo(
    () => filteredItems.filter((item) => item.status == null),
    [filteredItems]
  );

  function updateOpenCount(nextItems: MasterOpsInboxItem[]) {
    onCountChange(kind, nextItems.filter((item) => item.status == null).length);
  }

  async function markReviewed(targets: MasterOpsInboxItem[]) {
    const openTargets = targets.filter((item) => item.status == null);
    if (openTargets.length === 0) return;
    const ids = new Set(openTargets.map((item) => item.id));
    const previous = items;
    const next = items.map((item) => ids.has(item.id) ? { ...item, status: "reviewed" as const } : item);
    setItems(next);
    updateOpenCount(next);
    setSavingIds((current) => new Set([...current, ...ids]));

    try {
      await markMasterOpsInboxItemsReviewedAction({ items: openTargets.map(stateInput) });
    } catch (saveError) {
      setItems(previous);
      updateOpenCount(previous);
      setError(saveError instanceof Error ? saveError.message : "No se pudo marcar como leída.");
    } finally {
      setSavingIds((current) => {
        const nextSaving = new Set(current);
        ids.forEach((id) => nextSaving.delete(id));
        return nextSaving;
      });
    }
  }

  async function reopen(item: MasterOpsInboxItem) {
    if (item.status == null) return;
    const previous = items;
    const next = items.map((candidate) => candidate.id === item.id ? { ...candidate, status: null } : candidate);
    setItems(next);
    updateOpenCount(next);
    setSavingIds((current) => new Set(current).add(item.id));

    try {
      await reopenMasterOpsInboxItemsAction({ itemIds: [item.id] });
    } catch (saveError) {
      setItems(previous);
      updateOpenCount(previous);
      setError(saveError instanceof Error ? saveError.message : "No se pudo reabrir el seguimiento.");
    } finally {
      setSavingIds((current) => {
        const nextSaving = new Set(current);
        nextSaving.delete(item.id);
        return nextSaving;
      });
    }
  }

  function openItem(item: MasterOpsInboxItem) {
    if (kind === "updates" && item.status == null) void markReviewed([item]);
    onOpenOrder(item);
  }

  return (
    <div aria-label={kind === "actions" ? "Acciones pendientes" : "Seguimiento operativo"} aria-modal="true" className="fixed inset-0 z-[80]" role="dialog">
      <button aria-label="Cerrar bandeja" className="absolute inset-0 bg-black/70" onClick={onClose} type="button" />
      <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-[470px] flex-col border-l border-[#242433] bg-[#0B0B0D] text-[#F5F5F7] shadow-2xl">
        <header className="flex items-start justify-between gap-3 border-b border-[#242433] px-4 py-3">
          <div>
            <div className="text-base font-semibold">{kind === "actions" ? "Acciones" : "Seguimiento"}</div>
            <div className="mt-1 text-xs text-[#8A8A96]">
              {kind === "actions"
                ? "Pendientes que se cierran al ejecutar la acción real."
                : "Cambios informativos separados de las tareas pendientes."}
            </div>
          </div>
          <button
            aria-label="Cerrar"
            className="rounded-xl border border-[#242433] px-3 py-2 text-sm text-[#B7B7C2] hover:text-[#F5F5F7]"
            onClick={onClose}
            type="button"
          >
            ×
          </button>
        </header>

        {kind === "updates" ? (
          <div className="space-y-2 border-b border-[#242433] px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              {categoryOptions.map((option) => (
                <Chip
                  key={option.key}
                  active={categoryFilter === option.key}
                  label={option.label}
                  onClick={() => setCategoryFilter(option.key)}
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                {statusOptions.map((option) => (
                  <Chip
                    key={option.key}
                    active={statusFilter === option.key}
                    label={option.label}
                    onClick={() => setStatusFilter(option.key)}
                  />
                ))}
              </div>
              <button
                className="rounded-lg border border-[#242433] px-2.5 py-1 text-[11px] text-[#B7B7C2] transition hover:border-[#FEEF00]/40 hover:text-[#F5F5F7] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={reviewableFilteredItems.length === 0}
                onClick={() => void markReviewed(reviewableFilteredItems)}
                type="button"
              >
                Marcar visibles leídas
              </button>
            </div>
          </div>
        ) : null}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {loading ? (
            <div className="space-y-2" aria-live="polite">
              {[0, 1, 2].map((value) => (
                <div key={value} className="h-28 animate-pulse rounded-2xl border border-[#242433] bg-[#121218]" />
              ))}
            </div>
          ) : error && items.length === 0 ? (
            <div className="rounded-2xl border border-red-500/35 bg-red-500/10 p-4 text-sm text-red-100">
              <div>No se pudo cargar esta bandeja.</div>
              <button
                className="mt-3 rounded-xl border border-red-300/40 px-3 py-2 text-xs font-semibold"
                onClick={() => setReloadVersion((version) => version + 1)}
                type="button"
              >
                Reintentar
              </button>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="rounded-2xl border border-[#242433] bg-[#121218] px-4 py-6 text-center text-sm text-[#B7B7C2]">
              {kind === "actions" ? "No hay acciones pendientes." : "No hay seguimiento para este filtro."}
            </div>
          ) : (
            <div className="space-y-2">
              {error ? (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-100">{error}</div>
              ) : null}
              {filteredItems.map((item) => {
                const isSaving = savingIds.has(item.id);
                return (
                  <article
                    key={item.id}
                    className={[
                      "rounded-2xl border p-3",
                      item.status ? "border-[#242433] bg-[#101014] opacity-75" : "border-[#242433] bg-[#121218]",
                      item.severity === "critical" ? "border-red-500/45" : "",
                    ].join(" ")}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge label={item.badge} tone={item.severity === "critical" ? "danger" : item.severity === "warning" ? "warn" : "brand"} />
                          {item.isUrgent ? <Badge label="Urgente" tone="danger" /> : null}
                          {item.status === "reviewed" ? <Badge label="Leída" /> : null}
                          {item.status === "resolved" ? <Badge label="Cerrada" tone="brand" /> : null}
                        </div>
                        <div className="mt-2 truncate text-sm font-semibold">
                          Orden #{formatOrderDisplayNumber(item.orderId)} · {item.clientName}
                        </div>
                      </div>
                      <div className="shrink-0 text-right text-[10px] text-[#8A8A96]">
                        {formatMasterOrderDateTime(item.createdAt)}
                      </div>
                    </div>

                    <div className="mt-2 text-[12px] font-semibold text-[#F5F5F7]">{item.title}</div>
                    {item.message ? <div className="mt-1 text-[12px] text-[#B7B7C2]">{item.message}</div> : null}
                    {item.detailLines.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.detailLines.map((line) => <Badge key={`${item.id}-${line}`} label={line} />)}
                      </div>
                    ) : null}
                    <div className="mt-2 text-[11px] text-[#8A8A96]">
                      {item.advisorName} · Entrega: {item.deliveryLabel}
                    </div>

                    <div className="mt-3 flex gap-2">
                      <button
                        className="flex-1 rounded-xl border border-[#FEEF00]/45 bg-[#FEEF00]/10 px-3 py-2 text-sm font-semibold text-[#FEEF00] transition hover:bg-[#FEEF00]/15 disabled:opacity-50"
                        disabled={isSaving}
                        onClick={() => openItem(item)}
                        type="button"
                      >
                        {kind === "actions" ? item.badge : item.category === "payments" ? "Ver pagos" : item.category === "delivery" ? "Ver entrega" : "Ver orden"}
                      </button>
                      {kind === "updates" && item.status !== "resolved" ? (
                        <button
                          className="rounded-xl border border-[#242433] bg-[#0B0B0D] px-3 py-2 text-xs text-[#B7B7C2] transition hover:border-[#FEEF00]/40 hover:text-[#F5F5F7] disabled:opacity-50"
                          disabled={isSaving}
                          onClick={() => item.status == null ? void markReviewed([item]) : void reopen(item)}
                          type="button"
                        >
                          {isSaving ? "..." : item.status == null ? "Marcar leída" : "Reabrir"}
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
