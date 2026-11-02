import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import { orderMenuGraph, ids } from './order-menu-fixtures.ts';
import { defaultMenuOrderSelection, quoteMenuOrder, readMenuOrderQuote, type MenuOrderQuote } from '../../src/lib/brands/order-menu.ts';
import type { CounterDirectSaleIntent } from '../../src/app/app/counter/direct-sale-contract.ts';

const require = createRequire(import.meta.url);
const root = resolve('src');
const graph = orderMenuGraph();
function quote(kind: 'burger' | 'combo', extra = false) {
  const entry = graph.entries.find(e => e.entryId === ids[kind])!;
  const selection = defaultMenuOrderSelection(entry);
  if (extra) selection.extras = [{ entryId: ids.extra, variantKey: 'standard', quantity: 1 }];
  return quoteMenuOrder(graph, selection);
}
function driver() {
  const slots: unknown[] = []; let cursor = 0;
  const calls: CounterDirectSaleIntent[] = [], reads: unknown[] = [];
  const hooks = {
    useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (value: unknown) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
    useRef(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(fn: () => unknown) { return fn(); }, useEffect() {},
  };
  function MuerdemePicker() { return null; }
  const cache = new Map<string, Record<string, unknown>>();
  function load(file: string): Record<string, unknown> {
    let path = file; if (!existsSync(path)) path += existsSync(path + '.ts') ? '.ts' : '.tsx';
    const cached = cache.get(path); if (cached) return cached;
    const loaded = { exports: {} as Record<string, unknown> }; cache.set(path, loaded.exports);
    const source = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    new Function('require', 'exports', 'module', source)((name: string) => {
      if (name === 'react') return hooks;
      if (name === 'next/dynamic') return { default: () => MuerdemePicker };
      if (name === './actions') return { searchCounterClientsAction: async () => {
        reads.push('client'); return [{ id: 1, fullName: 'Cliente de prueba', phone: '584120000001', clientType: 'own', fundBalanceUsd: 0, advisorName: null }];
      } };
      if (name === './useCounterProductAvailability') return {
        isCounterProductSuspended: () => false,
        useCounterProductAvailability: () => ({ availabilityByProductId: new Map(), availabilityLoading: false, availabilityError: null }),
      };
      if (name.startsWith('@/')) return load(resolve(root, name.slice(2)));
      if (name.startsWith('./') || name.startsWith('../')) return load(resolve(dirname(path), name));
      return require(name);
    }, loaded.exports, loaded);
    cache.set(path, loaded.exports); return loaded.exports;
  }
  const Panel = load(resolve(root, 'app/app/counter/CounterQuickSaleWorkspace.tsx')).CounterQuickSalePanel as (props: unknown) => unknown;
  const product = { id: 1, name: 'Tequeños VIVO', sku: 'VIVO-1', type: 'product', sourcePriceCurrency: 'USD', sourcePriceAmount: 14, basePriceUsd: 14, basePriceBs: 12040 };
  const props = { products: [product], productComponents: [], discountRules: [], activeBsRate: 860, isWorking: false, onCancel() {}, onSubmit(input: CounterDirectSaleIntent) { calls.push(input); } };
  const render = () => { cursor = 0; return Panel(props); };
  type Node = { type: unknown; props: {
    children?:unknown; disabled?:boolean; placeholder?:string; value?:string;
    onClick:()=>void; onChange:(event:{target:{value:string}})=>void;
    onAdd:(quote:MenuOrderQuote,enabled:boolean)=>void; edit:{key:string;quote:MenuOrderQuote}|null;
  } };
  const nodes = (value: unknown): Node[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value as Node, ...nodes((value as Node).props?.children)];
  const text = (value: unknown): string => value == null ? '' : Array.isArray(value) ? value.map(text).join('') : typeof value === 'object' ? text((value as Node).props?.children) : String(value);
  const find = (predicate: (node: Node) => boolean) => { const n = nodes(render()).find(predicate); assert.ok(n, 'Expected Counter control'); return n; };
  const picker = () => find(n => n.type === MuerdemePicker);
  const click = (label: string) => { const n = find(n => n.type === 'button' && text(n) === label); assert.ok(!n.props.disabled, label); n.props.onClick(); };
  const customer = async () => {
    find(n => n.type === 'input' && n.props.placeholder === 'Buscar por telefono o nombre').props.onChange({ target: { value: 'Cliente' } });
    click('Buscar'); await Promise.resolve(); await Promise.resolve();
    find(n => n.type === 'button' && text(n).includes('Cliente de prueba')).props.onClick();
  };
  const addVivo = () => {
    find(n => n.type === 'input' && n.props.placeholder === 'Buscar producto').props.onChange({ target: { value: 'Tequeños' } });
    find(n => n.type === 'button' && text(n).includes('Tequeños VIVO')).props.onClick(); click('Agregar');
  };
  return { calls, reads, render, nodes, text, find, picker, click, customer, addVivo };
}

test('Counter starts with a deferred menu and makes no customer/menu query on mount', () => {
  const ui = driver(); ui.render(); assert.equal(typeof ui.picker().props.onAdd, 'function'); assert.deepEqual(ui.reads, []);
});
test('two configurations of the same burger stay independent and retain the canonical price without a catalogue adapter', () => {
  const ui = driver(), a = quote('burger'), b = quote('burger', true);
  ui.picker().props.onAdd(a, true); ui.picker().props.onAdd(b, true);
  const text = ui.text(ui.render()); assert.ok(text.includes(a.title)); assert.ok(text.includes(b.title));
  assert.equal(ui.nodes(ui.render()).filter(n => n.type === 'button' && ui.text(n) === 'Configurar').length, 2);
  assert.ok(text.includes('$10,75')); assert.ok(text.includes('Bs 9.245,00')); assert.ok(!text.includes('@muerdeme|'));
});
test('editing one burger preserves the other and one combo keeps its own individual burger configuration', () => {
  const ui = driver(), a = quote('burger'), b = quote('burger', true), combo = quote('combo');
  ui.picker().props.onAdd(a, true); ui.picker().props.onAdd(combo, true);
  ui.click('Configurar'); const key = ui.picker().props.edit!.key;
  ui.picker().props.onAdd(b, true);
  assert.equal(ui.picker().props.edit, null);
  ui.click('Configurar'); assert.equal(ui.picker().props.edit!.key, key); assert.equal(ui.picker().props.edit!.quote.unitUsd, b.unitUsd);
  assert.ok(ui.text(ui.render()).includes(combo.title));
});
test('mixed Counter checkout sends one order with VIVO and separately configured Muérdeme lines and preserves WhatsApp', async () => {
  const ui = driver(); await ui.customer(); ui.addVivo();
  const burger = quote('burger'), combo = quote('combo');
  ui.picker().props.onAdd(burger, true); ui.picker().props.onAdd(combo, true);
  ui.find(n => n.type === 'select' && n.props.value === 'in_person').props.onChange({ target: { value: 'whatsapp' } });
  ui.click('Crear y enviar a cocina');
  assert.equal(ui.calls.length, 1); const input = ui.calls[0];
  assert.equal(input.salesChannel, 'whatsapp'); assert.equal(input.clientId, 1); assert.equal(input.items.length, 3);
  assert.equal(readMenuOrderQuote(input.items[0].editableDetailLines), null);
  assert.deepEqual(readMenuOrderQuote(input.items[1].editableDetailLines), burger);
  assert.deepEqual(readMenuOrderQuote(input.items[2].editableDetailLines), combo);
  assert.deepEqual(input.items.map(i => i.qty), [1, 1, 1]);
});
test('preparation blocks submission; removing only Muérdeme restores the existing VIVO sale', async () => {
  const ui = driver(); await ui.customer(); ui.addVivo(); ui.picker().props.onAdd(quote('burger'), false);
  ui.click('Crear y enviar a cocina'); assert.equal(ui.calls.length, 0); assert.ok(ui.text(ui.render()).includes('apertura comercial sigue pendiente'));
  const rows = ui.nodes(ui.render()).filter(n => n.type === 'button' && ui.text(n) === 'Quitar'); rows[1].props.onClick();
  ui.click('Crear y enviar a cocina'); assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].items.length, 1);
});
