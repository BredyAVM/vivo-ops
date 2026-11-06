import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

function client(loader: (id: number) => Promise<unknown>, modern: boolean) {
  const calls: string[] = [];
  const values: string[] = [];
  const source = readFileSync(new URL('../../src/lib/orders/copy-live-whatsapp.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}});
  class Item {
    data: Record<string, Promise<Blob>>;
    constructor(data: Record<string, Promise<Blob>>) {this.data = data;}
  }
  const exports: {copyLiveOrderWhatsApp?: (id: number) => Promise<void>} = {};
  runInNewContext(compiled.outputText, {
    exports, Blob, Error,
    require: () => ({loadLiveOrderWhatsAppAction: (id: number) => {calls.push('read'); return loader(id);}}),
    ClipboardItem: modern ? Item : undefined,
    navigator: {clipboard: {
      write: async (items: Item[]) => {calls.push('write'); values.push(await (await items[0].data['text/plain']).text());},
      writeText: async (value: string) => {calls.push('writeText'); values.push(value);},
    }},
  });
  return {copy: exports.copyLiveOrderWhatsApp!, calls, values};
}

test('iPhone clipboard access is reserved before the server response arrives', async () => {
  let finish!: (value: unknown) => void;
  const c = client(() => new Promise(resolve => {finish = resolve;}), true);
  const copying = c.copy(1);
  assert.deepEqual(c.calls, ['read', 'write']);
  finish({ok: true, text: 'Pagado'});
  await copying;
  assert.deepEqual(c.values, ['Pagado']);
});

test('each click reads again and legacy clipboard receives only the newly returned text', async () => {
  let n = 0;
  const c = client(async () => ({ok: true, text: ++n === 1 ? 'Pendiente' : 'Pagado'}), false);
  await c.copy(1); await c.copy(1);
  assert.deepEqual(c.calls, ['read', 'writeText', 'read', 'writeText']);
  assert.deepEqual(c.values, ['Pendiente', 'Pagado']);
});

test('failed reads do not copy a previous summary and return the Spanish reason', async () => {
  for (const modern of [false, true]) {
    const c = client(async () => ({ok: false, message: 'No se pudo verificar el pago actual.'}), modern);
    await assert.rejects(c.copy(1), /No se pudo verificar el pago actual/);
    assert.deepEqual(c.values, []);
  }
});
