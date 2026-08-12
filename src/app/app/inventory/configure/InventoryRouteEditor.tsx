'use client';

import type { Dispatch, SetStateAction } from 'react';
import { inventoryUnitLabel } from '../display';

export type InventoryRouteMode = 'primary' | 'master_fallback';
export type InventoryRouteStage = '' | 'kitchen' | 'production' | 'packing' | 'fulfillment';

export type InventoryRouteLinkDraft = {
  key: string;
  inventoryItemId: string;
  quantityUnits: string;
  halfQuantityUnits: string;
  deductionStage: InventoryRouteStage;
};

export type InventoryRouteDraft = {
  key: string;
  routeKey: string;
  name: string;
  mode: InventoryRouteMode;
  links: InventoryRouteLinkDraft[];
};

type RouteItem = {
  id: number;
  name: string;
  unitName: string;
};

const INPUT_CLASS =
  'w-full rounded-xl border border-[#30303F] bg-[#0D0D12] px-3 py-2.5 text-sm text-white outline-none focus:border-[#FEEF00]/70 disabled:opacity-50';
const SECONDARY_BUTTON =
  'rounded-xl border border-[#41414F] bg-[#17171F] px-3 py-2 text-xs font-semibold text-[#D7D7DF] disabled:cursor-not-allowed disabled:opacity-40';

function newLink(): InventoryRouteLinkDraft {
  return {
    key: crypto.randomUUID(),
    inventoryItemId: '',
    quantityUnits: '1',
    halfQuantityUnits: '',
    deductionStage: 'kitchen',
  };
}

export function newPrimaryRoute(): InventoryRouteDraft {
  return {
    key: crypto.randomUUID(),
    routeKey: 'primary',
    name: 'Ruta principal',
    mode: 'primary',
    links: [newLink()],
  };
}

function newFallbackRoute(index: number): InventoryRouteDraft {
  return {
    key: crypto.randomUUID(),
    routeKey: `alternative_${index}`,
    name: `Ruta alternativa ${index}`,
    mode: 'master_fallback',
    links: [newLink()],
  };
}

export default function InventoryRouteEditor({
  routes,
  setRoutes,
  inventoryItems,
  allowsHalfService,
  disabled = false,
  allowFallbacks = true,
  allowMultipleLinks = true,
}: {
  routes: InventoryRouteDraft[];
  setRoutes: Dispatch<SetStateAction<InventoryRouteDraft[]>>;
  inventoryItems: RouteItem[];
  allowsHalfService: boolean;
  disabled?: boolean;
  allowFallbacks?: boolean;
  allowMultipleLinks?: boolean;
}) {
  function updateRoute(routeKey: string, update: (route: InventoryRouteDraft) => InventoryRouteDraft) {
    setRoutes((current) => current.map((route) => (route.key === routeKey ? update(route) : route)));
  }

  function addFallback() {
    setRoutes((current) => {
      let nextIndex = 1;
      while (current.some((route) => route.routeKey === `alternative_${nextIndex}`)) {
        nextIndex += 1;
      }
      return [...current, newFallbackRoute(nextIndex)];
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm font-semibold text-[#F4F4F7]">Rutas físicas del producto</div>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-[#92929F]">
            La ruta principal se usa normalmente. Las alternativas solo se aplican cuando el Máster
            las selecciona para una orden; nunca convierten el stock ni lo cuentan dos veces.
          </p>
        </div>
        {allowFallbacks ? (
          <button
            type="button"
            onClick={addFallback}
            disabled={disabled || routes.length >= 10}
            className={SECONDARY_BUTTON}
          >
            Agregar ruta alternativa
          </button>
        ) : null}
      </div>

      {routes.map((route, routeIndex) => (
        <section
          key={route.key}
          className={`rounded-xl border p-4 ${
            route.mode === 'primary'
              ? 'border-emerald-400/25 bg-emerald-400/5'
              : 'border-amber-400/25 bg-amber-400/5'
          }`}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <label className="block flex-1 text-sm">
              <span className="mb-2 block text-[#BDBDC7]">Nombre de la ruta</span>
              <input
                value={route.name}
                onChange={(event) => updateRoute(route.key, (current) => ({
                  ...current,
                  name: event.target.value,
                }))}
                maxLength={100}
                disabled={disabled}
                className={INPUT_CLASS}
                placeholder={route.mode === 'primary' ? 'Ej. Freír desde crudo' : 'Ej. Terminar desde prefrito'}
              />
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-3 py-2 text-xs font-semibold ${
                route.mode === 'primary'
                  ? 'border-emerald-400/30 text-emerald-200'
                  : 'border-amber-400/30 text-amber-200'
              }`}>
                {route.mode === 'primary' ? 'Principal' : 'Decisión del Máster'}
              </span>
              {route.mode !== 'primary' ? (
                <button
                  type="button"
                  onClick={() => setRoutes((current) => current.filter((candidate) => candidate.key !== route.key))}
                  disabled={disabled}
                  className={SECONDARY_BUTTON}
                >
                  Quitar ruta
                </button>
              ) : null}
            </div>
          </div>

          <div className="mt-4 space-y-3">
              {route.links.slice(0, allowMultipleLinks ? route.links.length : 1).map((line) => {
              const selectedItem = inventoryItems.find((item) => item.id === Number(line.inventoryItemId));
              const unitName = inventoryUnitLabel(selectedItem?.unitName, 'unidad base');
              return (
                <div
                  key={line.key}
                  className="grid gap-2 rounded-xl border border-white/10 bg-[#0D0D12]/75 p-3 xl:grid-cols-[minmax(220px,1fr)_170px_170px_190px_auto]"
                >
                  <label className="text-xs text-[#AFAFBA]">
                    <span className="mb-1.5 block">Ítem físico consumido</span>
                    <select
                      value={line.inventoryItemId}
                      onChange={(event) => updateRoute(route.key, (current) => ({
                        ...current,
                        links: current.links.map((candidate) => candidate.key === line.key
                          ? { ...candidate, inventoryItemId: event.target.value }
                          : candidate),
                      }))}
                      disabled={disabled}
                      className={INPUT_CLASS}
                    >
                      <option value="">Seleccionar ítem</option>
                      {inventoryItems.map((item) => (
                        <option key={item.id} value={item.id}>{item.name} · {item.unitName}</option>
                      ))}
                    </select>
                  </label>
                  <label className="text-xs text-[#AFAFBA]">
                    <span className="mb-1.5 block">Servicio completo ({unitName})</span>
                    <input
                      inputMode="decimal"
                      value={line.quantityUnits}
                      onChange={(event) => updateRoute(route.key, (current) => ({
                        ...current,
                        links: current.links.map((candidate) => candidate.key === line.key
                          ? { ...candidate, quantityUnits: event.target.value }
                          : candidate),
                      }))}
                      disabled={disabled}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <label className="text-xs text-[#AFAFBA]">
                    <span className="mb-1.5 block">Medio servicio ({unitName})</span>
                    <input
                      inputMode="decimal"
                      value={line.halfQuantityUnits}
                      onChange={(event) => updateRoute(route.key, (current) => ({
                        ...current,
                        links: current.links.map((candidate) => candidate.key === line.key
                          ? { ...candidate, halfQuantityUnits: event.target.value }
                          : candidate),
                      }))}
                      disabled={disabled || !allowsHalfService}
                      placeholder={allowsHalfService ? 'Automático si se deja vacío' : 'No aplica'}
                      className={INPUT_CLASS}
                    />
                  </label>
                  <label className="text-xs text-[#AFAFBA]">
                    <span className="mb-1.5 block">Momento del descuento</span>
                    <select
                      value={line.deductionStage}
                      onChange={(event) => updateRoute(route.key, (current) => ({
                        ...current,
                        links: current.links.map((candidate) => candidate.key === line.key
                          ? { ...candidate, deductionStage: event.target.value as InventoryRouteStage }
                          : candidate),
                      }))}
                      disabled={disabled}
                      className={INPUT_CLASS}
                    >
                      <option value="fulfillment">Al entregar</option>
                      <option value="kitchen">En cocina</option>
                      <option value="production">En producción</option>
                      <option value="packing">Al empacar</option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => updateRoute(route.key, (current) => ({
                      ...current,
                      links: current.links.filter((candidate) => candidate.key !== line.key),
                    }))}
                    disabled={disabled || route.links.length <= 1}
                    className={`${SECONDARY_BUTTON} self-end`}
                  >
                    Quitar
                  </button>
                </div>
              );
            })}
          </div>

          {allowMultipleLinks ? (
            <button
              type="button"
              onClick={() => updateRoute(route.key, (current) => ({
                ...current,
                links: [...current.links, newLink()],
              }))}
              disabled={disabled || route.links.length >= 50}
              className={`${SECONDARY_BUTTON} mt-3`}
            >
              Agregar consumo a esta ruta
            </button>
          ) : null}

          {routeIndex === 0 ? (
            <p className="mt-3 text-[11px] leading-5 text-emerald-100/70">
              Esta ruta permanece reflejada en el vínculo canónico existente para conservar compatibilidad
              con reportes, alertas y productos ya creados.
            </p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
