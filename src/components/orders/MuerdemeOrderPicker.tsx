'use client';

import { useEffect, useRef, useState } from 'react';
import { loadMuerdemeOrderMenu, quoteMuerdemeOrderProduct, searchMuerdemeOrderMenu } from '@/lib/brands/order-menu-actions';
import { defaultMenuOrderSelection, menuUnit, quoteMenuOrder, type MenuOrderQuote, type MenuOrderSelection,
  type MenuUnitChoice, type OrderMenuGraph } from '@/lib/brands/order-menu';
import { menuKindLabels } from '@/lib/brands/menu-model';
import dynamic from 'next/dynamic';
const MuerdemePreparationPreview = dynamic(() => import('./MuerdemePreparationPreview'));

const field = 'min-h-11 min-w-0 w-full rounded-lg border border-[#393944] bg-[#111117] px-2 text-xs text-[#DEDEE6] md:min-h-8';
const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-[#393944] px-3 text-xs text-[#DEDEE6] hover:border-[#FFFF00]/60 disabled:opacity-50 md:min-h-8';
const money = (amount: number) => `USD ${amount.toFixed(2).replace('.', ',')}`;
type SearchResult = Awaited<ReturnType<typeof searchMuerdemeOrderMenu>>;

function UnitOptions({ unit, graph, onChange }: { unit: MenuUnitChoice; graph: OrderMenuGraph; onChange: (next: MenuUnitChoice) => void }) {
  const entry = graph.entries.find(e => e.entryId === unit.entryId);
  const variant = entry?.document.variants.find(v => v.key === unit.variantKey);
  if (!entry || !variant) return <p role="alert">Presentación no disponible. Vuelve a seleccionarla.</p>;
  const burger = variant.burger;
  const friesRef = burger?.includedFries ?? (entry.document.kind === 'fries' ? unit : null);
  const fries = graph.entries.find(e => e.entryId === friesRef?.entryId);
  const upgrades = fries?.document.friesUpgrades.filter(u => u.fromKey === friesRef?.variantKey) ?? [];
  return <div className="min-w-0 space-y-2">
    {burger ? <>
      <fieldset className="min-w-0"><legend className="mb-1 text-[#BDBDC7]">Incluye · desmarca para retirar</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">{burger.ingredients.map(ingredient => <label key={ingredient.key} className="flex min-h-9 items-center gap-2 break-words">
          <input type="checkbox" className="accent-[#FFFF00]" checked={!unit.removed.includes(ingredient.key)} disabled={!ingredient.removable}
            onChange={e => onChange({ ...unit, removed: e.target.checked ? unit.removed.filter(k => k !== ingredient.key) : [...unit.removed, ingredient.key] })} />
          {ingredient.label}{!ingredient.removable ? <span className="text-[#BDBDC7]">(incluido)</span> : null}
        </label>)}</div>
        {!burger.ingredients.length ? <p className="text-[#BDBDC7]">Sin retiros configurados.</p> : null}
      </fieldset>
      {burger.extras.length ? <fieldset className="min-w-0 space-y-1"><legend className="mb-1 text-[#BDBDC7]">Extras · USD</legend>
        {burger.extras.map(allowed => {
          const extra = graph.entries.find(e => e.entryId === allowed.entryId);
          const extraVariant = extra?.document.variants.find(v => v.key === allowed.variantKey);
          const selected = unit.extras.find(e => e.entryId === allowed.entryId && e.variantKey === allowed.variantKey);
          return <label key={`${allowed.entryId}:${allowed.variantKey}`} className="grid min-w-0 grid-cols-[minmax(0,1fr)_68px] items-center gap-2">
            <span className="break-words">{extra?.document.name} · {extraVariant?.label} · {extraVariant?.priceUsd == null ? 'Precio pendiente' : money(extraVariant.priceUsd)}</span>
            <select aria-label={`Cantidad de ${extra?.document.name} · ${extraVariant?.label}`} className={field} disabled={extraVariant?.priceUsd == null || extra?.document.archived}
              value={selected?.quantity ?? 0} onChange={e => {
                const others = unit.extras.filter(x => x.entryId !== allowed.entryId || x.variantKey !== allowed.variantKey);
                onChange({ ...unit, extras: Number(e.target.value) ? [...others, { entryId: allowed.entryId, variantKey: allowed.variantKey, quantity: Number(e.target.value) }] : others });
              }}>{Array.from({ length: allowed.maxQty + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}</select>
          </label>;
        })}
      </fieldset> : null}
    </> : null}
    {friesRef && fries ? <label className="grid gap-1 text-[#BDBDC7]">{burger ? `Papas incluidas · ${burger.includedFries?.quantity} porción(es)` : 'Tamaño de papas'}
      <select className={field} value={unit.friesUpgrade ?? ''} onChange={e => onChange({ ...unit, friesUpgrade: e.target.value || null })}>
        <option value="">{fries.document.variants.find(v => v.key === friesRef.variantKey)?.label} · incluido</option>
        {upgrades.map(u => <option key={u.toKey} value={u.toKey}>{fries.document.variants.find(v => v.key === u.toKey)?.label} · +{money(u.supplementUsd * (burger?.includedFries?.quantity ?? 1))}</option>)}
      </select></label> : null}
  </div>;
}

export function MuerdemeProductConfigurator({ graph, initial, onCancel, onConfirm, validateQuote = quoteMuerdemeOrderProduct }: {
  graph: OrderMenuGraph; initial: MenuOrderSelection; onCancel: () => void; onConfirm: (quote: MenuOrderQuote) => void;
  validateQuote?: typeof quoteMuerdemeOrderProduct;
}) {
  const [selection, setSelection] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const root = graph.entries.find(e => e.entryId === selection.entryId)!;
  let quote: MenuOrderQuote | null = null, issue = '';
  try { quote = quoteMenuOrder(graph, selection); } catch (err) { issue = err instanceof Error ? err.message : 'Revisa las opciones.'; }
  return <section aria-label={`Configurar ${root.document.name}`} className="min-w-0 space-y-3 rounded-lg border border-[#FFFF00]/40 bg-[#111117] p-3 text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-[#DEDEE6]">{root.document.name}</h3>
      <span className="font-medium text-[#FFFF00]" aria-live="polite">{quote ? money(quote.unitUsd) : 'Revisar opciones'}</span></div>
    <label className="grid gap-1 text-[#BDBDC7]">Presentación<select className={field} value={selection.variantKey} disabled={busy}
      onChange={e => setSelection(defaultMenuOrderSelection(root, e.target.value))}>{root.document.variants.map(v => <option key={v.key} value={v.key}>
        {v.label} · {v.priceUsd === null ? 'Precio pendiente' : money(v.priceUsd)}</option>)}</select></label>
    <fieldset disabled={busy} className="min-w-0 space-y-2">
      {root.document.kind !== 'combo' ? <UnitOptions unit={selection} graph={graph} onChange={unit => setSelection({ ...unit, slots: selection.slots })} /> :
        root.document.comboGroups.flatMap(group => Array.from({ length: group.quantity }, (_, position) => {
          const slot = selection.slots.find(s => s.groupKey === group.key && s.position === position)!;
          const component = graph.entries.find(e => e.entryId === slot.entryId);
          const componentVariant = component?.document.variants.find(v => v.key === slot.variantKey);
          const patch = (next: MenuUnitChoice) => setSelection(current => ({ ...current, slots: current.slots.map(s =>
            s.groupKey === group.key && s.position === position ? { ...next, groupKey: group.key, position } : s) }));
          return <details key={`${group.key}:${position}`} open={group.kind === 'burger' && position === 0} className="min-w-0 rounded-lg border border-[#393944] px-2">
            <summary className="min-h-11 cursor-pointer content-center break-words text-[#DEDEE6]">{group.label} {position + 1} · {component?.document.name} · {componentVariant?.label}
              {slot.removed.length ? ` · ${slot.removed.length} retiro(s)` : ''}{slot.extras.length ? ` · ${slot.extras.length} extra(s)` : ''}{slot.friesUpgrade ? ' · papas ampliadas' : ''}</summary>
            <div className="min-w-0 space-y-2 pb-2">
              {group.choices.length > 1 ? <label className="grid gap-1 text-[#BDBDC7]">Elegir {group.label.toLowerCase()} {position + 1}
                <select className={field} value={`${slot.entryId}|${slot.variantKey}`} onChange={e => { const [id, key] = e.target.value.split('|'); patch(menuUnit(id, key)); }}>
                  {group.choices.map(choice => {
                    const entry = graph.entries.find(e => e.entryId === choice.entryId);
                    return <option key={`${choice.entryId}:${choice.variantKey}`} value={`${choice.entryId}|${choice.variantKey}`}>
                      {entry?.document.name} · {entry?.document.variants.find(v => v.key === choice.variantKey)?.label} · {choice.supplementUsd ? `+${money(choice.supplementUsd)}` : 'incluido'}
                    </option>;
                  })}</select></label> : null}
              <UnitOptions unit={slot} graph={graph} onChange={patch} />
            </div>
          </details>;
        }))}
    </fieldset>
    {quote ? <details className="min-w-0 text-[#BDBDC7]"><summary className="min-h-9 cursor-pointer content-center">Ver desglose</summary>
      <ul className="space-y-1 break-words">{quote.detailLines.map((line, i) => <li key={i}>{line}</li>)}</ul></details> : null}
    {quote ? <MuerdemePreparationPreview quote={quote} /> : null}
    {error || issue ? <p role="alert" className="text-red-300">{error || issue}</p> : null}
    <div className="flex flex-wrap items-center justify-end gap-2"><button type="button" className={button} disabled={busy} onClick={onCancel}>Cancelar</button>
      <button type="button" className={`${button} border-[#FFFF00] bg-[#FFFF00] font-medium !text-black`} disabled={busy || !quote} onClick={async () => {
        if (!quote || busy) return;
        setBusy(true); setError('');
        try { onConfirm(await validateQuote(selection, quote.revisions)); }
        catch (err) { setError(err instanceof Error ? err.message : 'No se pudo comprobar el producto.'); }
        finally { setBusy(false); }
      }}>{busy ? 'Comprobando…' : 'Añadir al pedido'}</button></div>
  </section>;
}

export default function MuerdemeOrderPicker({ onAdd, edit, onEditDone, disabled = false }: {
  onAdd: (quote: MenuOrderQuote, salesEnabled: boolean) => void; edit?: { key: string; quote: MenuOrderQuote } | null;
  onEditDone?: () => void; disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [result, setResult] = useState<SearchResult | null>(null);
  const appliedFilters = useRef({ query: '', kind: '' });
  const [graph, setGraph] = useState<OrderMenuGraph | null>(null);
  const [initial, setInitial] = useState<MenuOrderSelection | null>(null);
  const [editKey, setEditKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    if (!edit) return;
    let cancelled = false;
    setBusy(true); setError(''); setExpanded(true);
    void loadMuerdemeOrderMenu(edit.quote.selection.entryId).then(value => {
      if (!cancelled) { setGraph(value); setInitial(edit.quote.selection); setEditKey(edit.key); }
    }).catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : 'No se pudo abrir el producto.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [edit]);
  const consult = async (page = 1) => {
    const run = ++sequence.current;
    setBusy(true); setError('');
    const filters = page === 1 ? { query, kind } : appliedFilters.current;
    try { const next = await searchMuerdemeOrderMenu(filters.query, filters.kind || null, page); if (run === sequence.current) {
      setResult(next); appliedFilters.current = filters;
    } }
    catch (err) { if (run === sequence.current) setError(err instanceof Error ? err.message : 'No se pudo consultar.'); }
    finally { if (run === sequence.current) setBusy(false); }
  };
  // Menus load only after an explicit consultation or edit, never on editor mount.
  const open = async (entryId: string, previous?: MenuOrderQuote, key?: string) => {
    setBusy(true); setError('');
    try {
      const value = await loadMuerdemeOrderMenu(entryId);
      setGraph(value); setInitial(previous?.selection ?? defaultMenuOrderSelection(value.entries.find(e => e.entryId === entryId)!));
      setEditKey(key ?? null); setExpanded(true);
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo abrir el producto.'); }
    finally { setBusy(false); }
  };
  return <div className="min-w-0 space-y-2 text-xs">
    <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={disabled || busy} aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>Muérdeme · menú</button>
      {busy ? <span role="status" className="self-center text-[#BDBDC7]">Consultando…</span> : null}</div>
    {expanded ? <div className="min-w-0 space-y-2 rounded-lg border border-[#393944] p-2">
      <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
        <label className="grid min-w-0 gap-1 text-[#BDBDC7]">Buscar Muérdeme<input className={field} maxLength={100} value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); if (!busy) void consult(); }
        }} /></label>
        <label className="grid gap-1 text-[#BDBDC7]">Tipo<select className={field} value={kind} onChange={e => setKind(e.target.value)}>
          <option value="">Todos</option>{(['burger','fries','combo'] as const).map(k => <option key={k} value={k}>{menuKindLabels[k]}</option>)}</select></label>
        <button type="button" className={`${button} self-end`} disabled={busy} onClick={() => { setGraph(null); setInitial(null); void consult(); }}>Consultar menú</button>
      </div>
      {result && !result.salesEnabled ? <p className="text-amber-200">En preparación · puedes configurar y revisar el pedido. Las ventas de Muérdeme todavía no están habilitadas.</p> : null}
      {result ? <div className="min-w-0 divide-y divide-[#30303D]">{result.rows.map(row => <div key={row.entryId} className="flex min-w-0 items-center justify-between gap-2 py-2">
        <span className="min-w-0 break-words text-[#DEDEE6]">{row.name}<span className="ml-2 text-[#BDBDC7]">{row.fromUsd === null ? 'Precio pendiente' : `Desde ${money(row.fromUsd)}`}</span></span>
        <button type="button" className={`${button} shrink-0`} disabled={busy || !row.productId} onClick={() => open(row.entryId)}>Elegir</button>
      </div>)}{!result.rows.length ? <p className="py-2 text-[#BDBDC7]">No hay productos disponibles con estos filtros.</p> : null}</div> : null}
      {result && (result.page > 1 || result.hasNext) ? <div className="flex gap-2"><button type="button" className={button} disabled={busy || result.page === 1} onClick={() => consult(result.page - 1)}>Anterior</button>
        <button type="button" className={button} disabled={busy || !result.hasNext} onClick={() => consult(result.page + 1)}>Siguiente</button></div> : null}
      {graph && initial ? <MuerdemeProductConfigurator key={`${initial.entryId}:${editKey ?? 'new'}:${graph.entries.map(e => e.revision).join(',')}`}
        graph={graph} initial={initial} onCancel={() => { setGraph(null); setInitial(null); setEditKey(null); onEditDone?.(); }}
        onConfirm={quote => { onAdd(quote, graph.salesEnabled); setGraph(null); setInitial(null); setEditKey(null); onEditDone?.(); }} /> : null}
    </div> : null}
    {error ? <p role="alert" className="text-red-300">{error}</p> : null}
  </div>;
}
