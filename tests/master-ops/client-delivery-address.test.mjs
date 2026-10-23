import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
const json = value => JSON.parse(JSON.stringify(value));
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const helpers = { exports: {} };
vm.runInNewContext(compile(read('src/lib/orders/client-delivery-address.ts')), helpers);
const { clientDeliveryAddresses: addresses, suggestSavedClientDeliveryAddress: suggest } = helpers.exports;
const client = { id: 123, fullName: 'Raúl', phone: '12345', clientType: 'legacy', recentAddresses: [
  { address_text: ' Las Lomas ', gps_url: 'https://maps.example/1' },
  { addressText: 'Otra dirección', gpsUrl: 'https://maps.example/2' },
] };
const blank = () => ({ fulfillment: 'pickup', deliveryAddress: '', deliveryGpsUrl: '', client: null, items: [],
  id: 0, status: 'created', fxRate: '886.23', paymentMethod: '', totalUsd: 14 });

test('accepts both client address shapes, deduplicates and rejects malformed entries without changing the profile', () => {
  const original = JSON.stringify(client);
  assert.deepEqual(json(addresses(client.recentAddresses)), [
    { addressText: 'Las Lomas', gpsUrl: 'https://maps.example/1' },
    { addressText: 'Otra dirección', gpsUrl: 'https://maps.example/2' },
  ]);
  assert.equal(JSON.stringify(client), original);
  assert.deepEqual(json(addresses([null, [], 1, 'text', {}, { address_text: {} }, { gpsUrl: 123 }])), []);
  assert.deepEqual(json(addresses(null)), []);
  assert.deepEqual(json(addresses([{ address_text: ' A  B ' }, { addressText: 'a b' },
    { gps_url: 'https://maps.example' }, { addressText: 'third' }])),
    [{ addressText: 'A  B', gpsUrl: '' }, { addressText: '', gpsUrl: 'https://maps.example' }]);
});
test('suggests the first stored address only for an empty delivery and changes no financial or order fields', () => {
  const before = { ...blank(), client, fulfillment: 'delivery' };
  const result = suggest(before, false);
  assert.equal(result.deliveryAddress, 'Las Lomas');
  assert.equal(result.deliveryGpsUrl, 'https://maps.example/1');
  assert.deepEqual(json({ ...result, deliveryAddress: '', deliveryGpsUrl: '' }), json(before));
  assert.equal(before.deliveryAddress, '');
  const pickup = { ...before, fulfillment: 'pickup' };
  assert.equal(suggest(pickup, false), pickup);
  const unknown = { ...before, client: null };
  assert.equal(suggest(unknown, false), unknown);
});
test('never replaces a recorded address, GPS-only location, manual text or deliberately cleared fields', () => {
  for (const fields of [{ deliveryAddress: 'Dirección de la orden' }, { deliveryGpsUrl: 'GPS manual' },
    { deliveryAddress: 'Manual', deliveryGpsUrl: 'GPS manual' }]) {
    const order = { ...blank(), client, fulfillment: 'delivery', ...fields };
    assert.equal(suggest(order, false), order);
  }
  const cleared = { ...blank(), client, fulfillment: 'delivery' };
  assert.equal(suggest(cleared, true), cleared);
});

const editor = read('src/app/app/master/ops/MasterOpsOrderEditor.tsx');
const ast = ts.createSourceFile('editor.tsx', editor, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(predicate) {
  let found;
  function visit(node) { if (predicate(node)) found = node; else ts.forEachChild(node, visit); }
  visit(ast); assert.ok(found); return found;
}
const selectClient = findNode(node => ts.isFunctionDeclaration(node) && node.name?.text === 'selectClient').getText(ast);
function changeHandler(field) {
  const opening = findNode(node => (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.attributes.properties.some(attribute =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'value' && attribute.initializer?.getText(ast) === `{form.${field}}`));
  const attr = opening.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'onChange');
  return attr.initializer.expression.getText(ast);
}
function runtime(form = blank()) {
  const context = vm.createContext({ form, deliveryAddressTouched: { current: false }, suggestSavedClientDeliveryAddress: suggest,
    setConfigState() {}, setError(message) { throw new Error(message); }, setNewClientName() {}, setNewClientPhone() {},
    setNewClientType() {}, setClientSearch() {}, setClientResults() {} });
  context.setForm = update => { context.form = typeof update === 'function' ? update(context.form) : update; };
  context.patchForm = patch => { context.form = { ...context.form, ...patch }; };
  vm.runInContext(compile(selectClient + `\nvar changeFulfillment=${changeHandler('fulfillment')};
    var changeAddress=${changeHandler('deliveryAddress')}; var changeGps=${changeHandler('deliveryGpsUrl')};`), context);
  return context;
}
const event = value => ({ target: { value } });
test('actual editor handlers work whether the operator selects the client or Delivery first', () => {
  for (const first of ['client', 'delivery']) {
    const ctx = runtime();
    if (first === 'client') { ctx.selectClient(client); assert.equal(ctx.form.deliveryAddress, ''); ctx.changeFulfillment(event('delivery')); }
    else { ctx.changeFulfillment(event('delivery')); assert.equal(ctx.form.deliveryAddress, ''); ctx.selectClient(client); }
    assert.equal(ctx.form.selectedClientId, 123);
    assert.equal(ctx.form.deliveryAddress, 'Las Lomas');
    assert.equal(ctx.form.deliveryGpsUrl, 'https://maps.example/1');
  }
});
test('actual editor handlers preserve manual fields across client changes and pickup/delivery toggles', () => {
  for (const field of ['address', 'gps', 'cleared']) {
    const ctx = runtime();
    if (field === 'gps') ctx.changeGps(event('GPS manual'));
    else ctx.changeAddress(event(field === 'cleared' ? '' : 'Manual'));
    ctx.selectClient(client);
    ctx.changeFulfillment(event('delivery'));
    ctx.changeFulfillment(event('pickup'));
    ctx.changeFulfillment(event('delivery'));
    assert.equal(ctx.form.deliveryAddress, field === 'address' ? 'Manual' : '');
    assert.equal(ctx.form.deliveryGpsUrl, field === 'gps' ? 'GPS manual' : '');
  }
  const ctx = runtime({ ...blank(), id: 3366, status: 'delivered', fulfillment: 'delivery', deliveryAddress: 'Dirección histórica' });
  ctx.selectClient(client);
  assert.equal(ctx.form.deliveryAddress, 'Dirección histórica');
  assert.equal(ctx.form.status, 'delivered');
});
test('opening an existing order stays read-only; saved address choices use explicit buttons with paired address/GPS', () => {
  assert.match(editor, /setForm\(isCreateMode \? suggestSavedClientDeliveryAddress\(loadedForm, false\) : loadedForm\)/);
  assert.match(editor, /deliveryAddressTouched.current = false/);
  assert.match(editor, /savedClientAddresses\.map\(\(address, index\)/);
  assert.match(editor, /aria-pressed=\{selected\}/);
  assert.match(editor, /patchForm\(\{ deliveryAddress: address.addressText, deliveryGpsUrl: address.gpsUrl \}\)/);
  assert.match(editor, /clientDeliveryAddresses\(form\?\.client\?\.recentAddresses\)/);
  const helper = read('src/lib/orders/client-delivery-address.ts');
  assert.doesNotMatch(helper, /supabase|fetch\(|localStorage|\.rpc\(/);
});
