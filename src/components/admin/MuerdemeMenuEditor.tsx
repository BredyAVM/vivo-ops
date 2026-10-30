'use client';

import { useActionState, useRef, useState } from 'react';
import { saveMuerdemeMenuDraft } from '@/lib/brands/menu-actions';
import {
  assertMenuReferences, menuKindLabels, menuMoneyText, menuPendingIssues, newMenuDocument,
  parseMenuDocument, parseMenuMoney, type MenuDocument, type MenuEditorData, type MenuKind, type MenuReference,
} from '@/lib/brands/menu-model';

const field = 'min-h-11 min-w-0 w-full rounded-lg border border-[#343442] bg-[#14141C] px-2 text-xs text-[#E4E4EA] md:min-h-8';
const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-[#343442] px-2 text-xs text-[#DEDEE6] hover:border-[#FFFF00]/50 md:min-h-8';
const label = 'grid min-w-0 gap-1 text-xs text-[#BDBDC7]';
const refValue = (ref: MenuReference) => ref.entryId && ref.variantKey ? `${ref.entryId}|${ref.variantKey}` : '';
const priceKey = (group: string, ref: MenuReference) => `${group}:${refValue(ref)}`;
function RefSelect({ lookups, kind, value, onChange, title }: {
  lookups: MenuEditorData['lookups']; kind: MenuKind; value: string; title: string;
  onChange: (ref: MenuReference) => void;
}) {
  const options = lookups.filter(item => item.kind === kind && !item.archived).flatMap(item => item.variants.map(variant => ({
    value: refValue({ entryId: item.entryId, variantKey: variant.key }),
    text: `${item.name} · ${variant.label}${variant.hasFries ? ' · incluye papas' : ''} · ${variant.priceUsd === null ? 'precio pendiente' : 'USD ' + menuMoneyText(variant.priceUsd)}`,
  })));
  return <label className={label}>{title}<select aria-label={title} className={field} value={value} disabled={options.length === 0} onChange={event => {
    const [entryId, variantKey] = event.target.value.split('|'); if (entryId && variantKey) onChange({ entryId, variantKey });
  }}><option value="">Seleccionar…</option>{options.map(option => <option key={option.value} value={option.value}>{option.text}</option>)}
    {value && !options.some(o => o.value === value) ? <option value={value}>Opción no disponible; vuelve a seleccionarla</option> : null}
  </select>{options.length === 0 ? <span className="text-[11px] text-[#BDBDC7]">Primero crea {kind === 'extra' ? 'los extras' : kind === 'fries' ? 'las papas' : kind === 'drink' ? 'las bebidas' : 'las hamburguesas'} en el catálogo para poder vincularlos.</span> : null}</label>;
}

export default function MuerdemeMenuEditor({ data, kind, returnTo }: { data: MenuEditorData; kind: MenuKind; returnTo: string }) {
  const [document, setDocument] = useState<MenuDocument>(() => data.entry?.document ?? newMenuDocument(kind));
  const [priceTexts, setPriceTexts] = useState<Record<string, string>>({});
  const attempt = useRef<{ id: string; payload: string } | null>(null);
  const update = (change: (doc: MenuDocument) => void) => setDocument(previous => {
    const next = structuredClone(previous); change(next); return next;
  });
  const amountText = (key: string, amount: number | null) => priceTexts[key] ?? menuMoneyText(amount);
  const changePrice = (key: string, text: string) => setPriceTexts(previous => ({ ...previous, [key]: text }));
  const referenceName = (ref: MenuReference) => {
    const entry = data.lookups.find(e => e.entryId === ref.entryId);
    return entry ? `${entry.name} · ${entry.variants.find(v => v.key === ref.variantKey)?.label ?? 'Presentación no disponible'}` : 'Opción no disponible';
  };
  const [state, action, pending] = useActionState(async (previous: { error: string }, form: FormData) => {
    let payload: string;
    try {
      const next = structuredClone(document);
      next.name = next.name.trim();
      for (const v of next.variants) v.priceUsd = parseMenuMoney(amountText(v.key, v.priceUsd), true);
      for (const g of next.comboGroups) for (const c of g.choices) c.supplementUsd = parseMenuMoney(amountText(priceKey(g.key, c), c.supplementUsd))!;
      for (const u of next.friesUpgrades) u.supplementUsd = parseMenuMoney(amountText(`upgrade:${u.fromKey}:${u.toKey}`, u.supplementUsd))!;
      if (next.kind === 'combo') next.comboIncentiveUsd = parseMenuMoney(amountText('combo-incentive', next.comboIncentiveUsd ?? null), true);
      parseMenuDocument(next); assertMenuReferences(next, data.lookups);
      payload = JSON.stringify(next);
    } catch (error) { return { error: error instanceof Error ? error.message : 'Revisa la configuración.' }; }
    const signature = JSON.stringify([data.entry?.entryId, data.entry?.revision ?? 0, payload]);
    if (!attempt.current || attempt.current.payload !== signature) attempt.current = { id: crypto.randomUUID(), payload: signature };
    form.set('document', payload); form.set('operationId', attempt.current.id);
    form.set('entryId', data.entry?.entryId ?? ''); form.set('revision', String(data.entry?.revision ?? 0)); form.set('returnTo', returnTo);
    return saveMuerdemeMenuDraft(previous, form);
  }, { error: '' });

  const pendingIssues = menuPendingIssues(document).filter(issue => issue !== 'Completar precios en USD');
  if (document.variants.some(v => amountText(v.key, v.priceUsd).trim() === '')) pendingIssues.unshift('Completar precios en USD');
  return <form action={action} noValidate aria-busy={pending} className="min-w-0 space-y-3 text-xs">
    <fieldset disabled={pending} className="min-w-0 space-y-3">
      <div className="grid min-w-0 gap-3 sm:grid-cols-[1fr_auto]">
        <label className={label}>Nombre del producto<input className={field} maxLength={120} value={document.name} required onChange={e => update(d => { d.name = e.target.value; })} /></label>
        <p className="self-end py-2 text-[#BDBDC7]">{menuKindLabels[document.kind]} · En preparación</p>
      </div>
      <section className="space-y-2" aria-label="Presentaciones">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium text-[#DEDEE6]">Presentaciones y precios</h2>
          <button type="button" className={button} disabled={document.variants.length >= 20} onClick={() => update(d => { d.variants.push({
            key: 'v_' + crypto.randomUUID(), label: '', priceUsd: null,
            burger: d.kind === 'burger' ? { pattyCount: 1, ingredients: [], extras: [], includedFries: null } : null,
          }); })}>+ Presentación</button>
        </div>
        {document.variants.map((variant, index) => <details key={variant.key} open={index === 0} className="min-w-0 rounded-lg border border-[#30303D] bg-[#111117] px-3">
          <summary className="min-h-11 cursor-pointer content-center break-words text-xs text-[#DEDEE6]">{variant.label || 'Nueva presentación'}{variant.burger && variant.label.trim().toLowerCase() !== (variant.burger.pattyCount === 2 ? 'doble' : 'simple') ? ` · ${variant.burger.pattyCount === 2 ? 'Doble' : 'Simple'}` : ''}{variant.burger?.includedFries ? ' · incluye papas' : ''}</summary>
          <div className="min-w-0 space-y-3 pb-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-2">
              <label className={label}>Nombre de presentación<input className={field} maxLength={100} required value={variant.label} onChange={e => update(d => { d.variants[index].label = e.target.value; })} /></label>
              <label className={label}>Precio completo · USD<input className={field} inputMode="decimal" maxLength={12} placeholder="Pendiente" value={amountText(variant.key, variant.priceUsd)} onFocus={e => e.currentTarget.select()} onChange={e => changePrice(variant.key, e.target.value)} /></label>
            </div>
            {variant.burger ? <>
              <label className={label}>Presentación de hamburguesa<select className={field} value={variant.burger.pattyCount} onChange={e => update(d => {
                d.variants[index].burger!.pattyCount = Number(e.target.value) as 1 | 2;
                if (['Simple', 'Doble'].includes(d.variants[index].label)) d.variants[index].label = e.target.value === '2' ? 'Doble' : 'Simple';
              })}><option value="1">Simple</option><option value="2">Doble</option></select></label>
              <div className="space-y-2"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-[#DEDEE6]">Ingredientes incluidos</h3>
                <button type="button" className={button} disabled={variant.burger.ingredients.length >= 40} onClick={() => update(d => { d.variants[index].burger!.ingredients.push({ key: 'i_' + crypto.randomUUID(), label: '', removable: true }); })}>+ Ingrediente</button></div>
                {variant.burger.ingredients.map((ingredient, ingredientIndex) => <div key={ingredient.key} className="flex min-w-0 flex-wrap items-center gap-2">
                  <label className={`${label} flex-1`}>Ingrediente {ingredientIndex + 1}<input className={field} required maxLength={80} value={ingredient.label} onChange={e => update(d => { d.variants[index].burger!.ingredients[ingredientIndex].label = e.target.value; })} /></label>
                  <label className="inline-flex min-h-11 items-center gap-1 self-end"><input type="checkbox" checked={ingredient.removable} onChange={e => update(d => { d.variants[index].burger!.ingredients[ingredientIndex].removable = e.target.checked; })} />Se puede retirar</label>
                  <button type="button" className={`${button} self-end`} aria-label={`Quitar ingrediente ${ingredientIndex + 1} de ${variant.label}`} onClick={() => update(d => { d.variants[index].burger!.ingredients.splice(ingredientIndex, 1); })}>Quitar</button>
                </div>)}
              </div>
              <div className="space-y-2"><h3 className="font-medium text-[#DEDEE6]">Extras permitidos</h3>
                <RefSelect lookups={data.lookups} kind="extra" value="" title="Añadir un extra del catálogo" onChange={ref => update(d => {
                  const extras = d.variants[index].burger!.extras;
                  if (!extras.some(e => refValue(e) === refValue(ref))) extras.push({ ...ref, maxQty: 1 });
                })} />
                {variant.burger.extras.map((extra, extraIndex) => <div key={refValue(extra)} className="flex min-w-0 flex-wrap items-end gap-2">
                  <span className="min-w-0 flex-1 break-words py-2 text-[#BDBDC7]">{referenceName(extra)}</span>
                  <label className={`${label} w-24`}>Máximo<input className={field} type="number" min={1} max={20} value={extra.maxQty} onFocus={e => e.currentTarget.select()} onChange={e => update(d => { d.variants[index].burger!.extras[extraIndex].maxQty = Number(e.target.value); })} /></label>
                  <button type="button" className={button} aria-label={`Quitar extra ${referenceName(extra)} de ${variant.label}`} onClick={() => update(d => { d.variants[index].burger!.extras.splice(extraIndex, 1); })}>Quitar</button>
                </div>)}
              </div>
              <div className="space-y-2"><label className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" checked={variant.burger.includedFries !== null} onChange={e => update(d => {
                d.variants[index].burger!.includedFries = e.target.checked ? { entryId: '', variantKey: '', quantity: 1 } : null;
              })} />Esta presentación ya incluye papas</label>
                {variant.burger.includedFries ? <div className="grid min-w-0 gap-2 sm:grid-cols-[1fr_6rem]">
                  <RefSelect lookups={data.lookups} kind="fries" title="Papas incluidas" value={refValue(variant.burger.includedFries)} onChange={ref => update(d => { d.variants[index].burger!.includedFries = { ...ref, quantity: d.variants[index].burger!.includedFries!.quantity }; })} />
                  <label className={label}>Porciones<input className={field} type="number" min={1} max={20} value={variant.burger.includedFries.quantity} onFocus={e => e.currentTarget.select()} onChange={e => update(d => { d.variants[index].burger!.includedFries!.quantity = Number(e.target.value); })} /></label>
                </div> : null}
              </div>
            </> : null}
            <div className="flex flex-wrap gap-2 border-t border-[#292937] pt-2">
              <button type="button" className={button} disabled={document.variants.length >= 20} onClick={() => {
                const copy = structuredClone(variant); copy.key = 'v_' + crypto.randomUUID(); copy.label = (variant.label + ' (copia)').slice(0, 100);
                changePrice(copy.key, amountText(variant.key, variant.priceUsd)); update(d => { d.variants.push(copy); });
              }}>Duplicar presentación</button>
              {document.variants.length > 1 ? <button type="button" className={button} onClick={() => update(d => {
                d.variants.splice(index, 1); d.friesUpgrades = d.friesUpgrades.filter(u => u.fromKey !== variant.key && u.toKey !== variant.key);
              })}>Quitar presentación</button> : null}
            </div>
          </div>
        </details>)}
        <p className="text-[11px] text-[#BDBDC7]">Cada presentación conserva su propio precio e ingredientes. Un precio vacío queda pendiente; cero significa sin cargo.</p>
      </section>
      {document.kind === 'combo' ? <section className="space-y-2" aria-label="Composición del combo">
        <div className="grid min-w-0 gap-2 rounded-lg border border-[#30303D] bg-[#111117] p-3 sm:grid-cols-[14rem_1fr]">
          <label className={label}>Estímulo fijo por pedido · USD<input className={field} inputMode="decimal" maxLength={12} placeholder="Usar tarifa habitual" value={amountText('combo-incentive', document.comboIncentiveUsd ?? null)} onFocus={e => e.currentTarget.select()} onChange={e => changePrice('combo-incentive', e.target.value)} /></label>
          <p className="self-center text-[11px] text-[#BDBDC7]">Vacío: usa la tarifa de primera compra o recurrencia. Cero: sin estímulo por este combo. Se aplica el mayor importe del pedido una sola vez; la bebida incluida no suma otra comisión. Los productos VIVO vendidos aparte conservan sus reglas.</p>
        </div>
        <h2 className="text-sm font-medium text-[#DEDEE6]">Contenido del combo</h2>
        <p className="text-[11px] text-[#BDBDC7]">Una opción hace el grupo fijo; varias permiten elegir. Cada hamburguesa se configurará por separado.</p>
        <div className="flex flex-wrap gap-2">{(['burger', 'fries', 'drink'] as const).map(groupKind => <button key={groupKind} type="button" className={button} disabled={document.comboGroups.length >= 12} onClick={() => update(d => { d.comboGroups.push({
          key: 'g_' + crypto.randomUUID(), label: groupKind === 'burger' ? 'Hamburguesas' : groupKind === 'drink' ? 'Bebidas' : 'Papas', kind: groupKind, quantity: 1, choices: [],
        }); })}>+ {menuKindLabels[groupKind]}</button>)}</div>
        {document.comboGroups.map((group, groupIndex) => <details key={group.key} open className="min-w-0 rounded-lg border border-[#30303D] bg-[#111117] px-3">
          <summary className="min-h-11 cursor-pointer content-center text-xs text-[#DEDEE6]">{group.label} · {group.quantity} {group.choices.length === 1 ? '· Fijo' : group.choices.length > 1 ? '· A elección' : '· Sin opciones'}</summary>
          <div className="min-w-0 space-y-3 pb-3">
            <div className="grid min-w-0 gap-2 sm:grid-cols-[1fr_6rem]"><label className={label}>Nombre del grupo<input className={field} value={group.label} maxLength={100} required onChange={e => update(d => { d.comboGroups[groupIndex].label = e.target.value; })} /></label>
              <label className={label}>Cantidad<input className={field} type="number" min={1} max={50} value={group.quantity} onFocus={e => e.currentTarget.select()} onChange={e => update(d => { d.comboGroups[groupIndex].quantity = Number(e.target.value); })} /></label></div>
            <RefSelect lookups={data.lookups} kind={group.kind} value="" title="Añadir opción permitida" onChange={ref => update(d => {
              const choices = d.comboGroups[groupIndex].choices;
              if (!choices.some(c => refValue(c) === refValue(ref))) choices.push({ ...ref, supplementUsd: 0 });
            })} />
            {group.choices.map((choice, choiceIndex) => <div key={refValue(choice)} className="flex min-w-0 flex-wrap items-end gap-2">
              <span className="min-w-0 flex-1 break-words py-2 text-[#BDBDC7]">{referenceName(choice)}</span>
              <label className={`${label} w-32`}>Suplemento · USD<input className={field} inputMode="decimal" maxLength={12} value={amountText(priceKey(group.key, choice), choice.supplementUsd)} onFocus={e => e.currentTarget.select()} onChange={e => changePrice(priceKey(group.key, choice), e.target.value)} /></label>
              <button type="button" className={button} aria-label={`Quitar opción ${referenceName(choice)} de ${group.label}`} onClick={() => update(d => { d.comboGroups[groupIndex].choices.splice(choiceIndex, 1); })}>Quitar</button>
            </div>)}
            <button type="button" className={button} onClick={() => update(d => { d.comboGroups.splice(groupIndex, 1); })}>Quitar grupo</button>
          </div>
        </details>)}
        <p className="text-[11px] text-[#BDBDC7]">El precio completo del combo cubre lo incluido. Suplemento cero mantiene ese precio; los extras se sumarán aparte.</p>
      </section> : null}
      {document.kind === 'fries' ? <section className="space-y-2" aria-label="Ampliaciones de papas">
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium text-[#DEDEE6]">Ampliar papas</h2>
          <button type="button" className={button} disabled={document.variants.length < 2 || document.friesUpgrades.length >= 50} onClick={() => update(d => {
            const pair = d.variants.flatMap(from => d.variants.map(to => ({ fromKey: from.key, toKey: to.key })))
              .find(pair => pair.fromKey !== pair.toKey && !d.friesUpgrades.some(u => u.fromKey === pair.fromKey && u.toKey === pair.toKey));
            if (pair) d.friesUpgrades.push({ ...pair, supplementUsd: 0 });
          })}>+ Ampliación</button></div>
        {document.friesUpgrades.map((upgrade, index) => <div key={`${upgrade.fromKey}:${upgrade.toKey}:${index}`} className="grid min-w-0 gap-2 rounded-lg border border-[#30303D] p-2 sm:grid-cols-[1fr_1fr_8rem_auto]">
          <label className={label}>Desde<select className={field} value={upgrade.fromKey} onChange={e => {
            changePrice(`upgrade:${e.target.value}:${upgrade.toKey}`, amountText(`upgrade:${upgrade.fromKey}:${upgrade.toKey}`, upgrade.supplementUsd));
            update(d => { d.friesUpgrades[index].fromKey = e.target.value; });
          }}>{document.variants.map(v => <option key={v.key} value={v.key}>{v.label || 'Sin nombre'}</option>)}</select></label>
          <label className={label}>Hasta<select className={field} value={upgrade.toKey} onChange={e => {
            changePrice(`upgrade:${upgrade.fromKey}:${e.target.value}`, amountText(`upgrade:${upgrade.fromKey}:${upgrade.toKey}`, upgrade.supplementUsd));
            update(d => { d.friesUpgrades[index].toKey = e.target.value; });
          }}>{document.variants.map(v => <option key={v.key} value={v.key}>{v.label || 'Sin nombre'}</option>)}</select></label>
          <label className={label}>Suplemento · USD<input className={field} inputMode="decimal" maxLength={12} value={amountText(`upgrade:${upgrade.fromKey}:${upgrade.toKey}`, upgrade.supplementUsd)} onFocus={e => e.currentTarget.select()} onChange={e => changePrice(`upgrade:${upgrade.fromKey}:${upgrade.toKey}`, e.target.value)} /></label>
          <button type="button" className={`${button} self-end`} onClick={() => update(d => { d.friesUpgrades.splice(index, 1); })}>Quitar</button>
        </div>)}
      </section> : null}
      {data.entry ? <label className="inline-flex min-h-11 items-center gap-2 text-[#BDBDC7]"><input type="checkbox" checked={document.archived} onChange={e => update(d => { d.archived = e.target.checked; })} />Archivar de la preparación</label> : null}
    </fieldset>
    <div className="sticky bottom-20 z-10 space-y-2 rounded-lg border border-[#30303D] bg-[#111117] p-3 md:bottom-3">
      {state.error ? <p role="alert" className="text-xs text-orange-200">{state.error}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] text-[#BDBDC7]">{pendingIssues.join(' · ') || 'Configuración en preparación'}</p>
        <button disabled={pending} className="min-h-11 rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-black disabled:opacity-50 md:min-h-8">{pending ? 'Guardando…' : 'Guardar preparación'}</button>
      </div>
    </div>
  </form>;
}
