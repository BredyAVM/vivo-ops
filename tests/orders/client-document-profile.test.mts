import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { clientDocumentProfilePatch } from '../../src/lib/clients/document-profile.ts';

const profile = {
  billing_company_name: 'Empresa guardada', billing_tax_id: 'J-123', billing_address: 'Direccion fiscal',
  billing_phone: '+584140000000', delivery_note_name: 'Recibe guardado', delivery_note_document_id: 'V-123',
  delivery_note_address: 'Direccion de nota', delivery_note_phone: '+584240000000',
};
const fields: Record<string, string> = {
  InvoiceCompanyName: 'billing_company_name', InvoiceTaxId: 'billing_tax_id', InvoiceAddress: 'billing_address',
  InvoicePhone: 'billing_phone', DeliveryNoteName: 'delivery_note_name', DeliveryNoteDocumentId: 'delivery_note_document_id',
  DeliveryNoteAddress: 'delivery_note_address', DeliveryNotePhone: 'delivery_note_phone',
};
const composer = readFileSync(new URL('../../src/app/app/advisor/new/AdvisorOrderComposer.tsx', import.meta.url), 'utf8');
const master = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url), 'utf8');

test('an order without documents does not erase either saved client profile', () => {
  const patch = clientDocumentProfilePatch({hasInvoice: false, hasDeliveryNote: false});
  assert.deepEqual(patch, {});
  assert.deepEqual({...profile, ...patch}, profile);
});

test('invoice updates are normalized and leave the delivery-note profile untouched', () => {
  const patch = clientDocumentProfilePatch({
    hasInvoice: true, hasDeliveryNote: false, invoiceCompanyName: ' Nueva empresa ',
    invoiceTaxId: ' J-456 ', invoiceAddress: ' Nueva direccion ', invoicePhone: '04140000000',
  });
  assert.deepEqual(patch, {billing_company_name: 'Nueva empresa', billing_tax_id: 'J-456',
    billing_address: 'Nueva direccion', billing_phone: '+584140000000'});
  assert.equal({...profile, ...patch}.delivery_note_name, profile.delivery_note_name);
});

test('delivery-note updates preserve the invoice profile', () => {
  const patch = clientDocumentProfilePatch({hasInvoice: false, hasDeliveryNote: true,
    deliveryNoteName: ' Otro receptor ', deliveryNoteDocumentId: ' V-456 ',
    deliveryNoteAddress: ' Otro sitio ', deliveryNotePhone: '04240000000'});
  assert.deepEqual(patch, {delivery_note_name: 'Otro receptor', delivery_note_document_id: 'V-456',
    delivery_note_address: 'Otro sitio', delivery_note_phone: '+584240000000'});
  assert.equal({...profile, ...patch}.billing_tax_id, profile.billing_tax_id);
});

test('both requested documents can update their data, including explicit blank fields', () => {
  const patch = clientDocumentProfilePatch({hasInvoice: true, hasDeliveryNote: true, invoiceCompanyName: ' Empresa '});
  assert.equal(Object.keys(patch).length, 8);
  assert.equal(patch.billing_company_name, 'Empresa');
  assert.equal(patch.billing_tax_id, null);
});

test('actual client hydration fills all eight fields and clears them when changing to no client', () => {
  const start = composer.indexOf('function applyClientProfile(');
  const source = composer.slice(start, composer.indexOf('async function detectClientCrmContext', start)).trim();
  const values: Record<string, string> = {};
  const setters = Object.fromEntries(Object.entries(fields).map(([name, key]) => ['set' + name, (value: string) => {values[key] = value;}]));
  const exports: {applyClientProfile?: (value: unknown) => void} = {};
  runInNewContext(ts.transpileModule('export ' + source, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, {exports, ...setters});
  exports.applyClientProfile!(profile);
  assert.deepEqual(values, profile);
  exports.applyClientProfile!(null);
  assert.ok(Object.values(values).every(value => value === ''));
});

test('actual document toggles do not erase the form values or enable a document automatically', () => {
  const tree = ts.createSourceFile('Composer.tsx', composer, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  for (const flag of ['hasInvoice', 'hasDeliveryNote']) {
    let callback = '';
    function visit(node: ts.Node) {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
        const checked = attributes.find(attr => attr.name.getText(tree) === 'checked');
        if (checked?.initializer && ts.isJsxExpression(checked.initializer) && checked.initializer.expression?.getText(tree) === flag) {
          const change = attributes.find(attr => attr.name.getText(tree) === 'onChange');
          if (change?.initializer && ts.isJsxExpression(change.initializer)) callback = change.initializer.expression!.getText(tree);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(callback, flag);
    const values = {...profile};
    const setters = Object.fromEntries(Object.entries(fields).map(([name, key]) => ['set' + name, (value: string) => {values[key as keyof typeof values] = value;}]));
    const exports: {change?: (event: {target: {checked: boolean}}) => void} = {};
    const context = {exports, ...setters, invoiceTaxPct: '16', setHasInvoice() {}, setHasDeliveryNote() {},
      setInvoicePanelOpen() {}, setDeliveryNotePanelOpen() {}, setInvoiceTaxPct() {}};
    runInNewContext(ts.transpileModule('export const change = ' + callback, {compilerOptions: {module: ts.ModuleKind.CommonJS}}).outputText, context);
    exports.change!({target: {checked: false}}); exports.change!({target: {checked: true}});
    assert.deepEqual(values, profile);
  }
});

test('client preload paths and all order writers share the non-destructive policy', () => {
  assert.match(composer, /setSelectedClient\(initialClient\);\s*applyClientProfile\(initialClient\)/);
  assert.match(composer, /setSelectedClient\(initialCrmContext.client\);\s*applyClientProfile\(initialCrmContext.client\)/);
  assert.match(composer, /\.\.\.clientDocumentProfilePatch\(\{/);
  assert.equal((master.match(/\.\.\.clientDocumentProfilePatch\(input\)/g) ?? []).length, 2);
  assert.doesNotMatch(master, /billing_company_name: input.hasInvoice/);
  // The order's own document snapshot is still absent when it was not requested.
  assert.match(composer, /invoice_snapshot: hasInvoice\s*\?/);
  assert.match(composer, /delivery_note_snapshot: hasDeliveryNote\s*\?/);
  const profileLoader = composer.slice(composer.indexOf('function applyClientProfile('), composer.indexOf('async function detectClientCrmContext'));
  assert.doesNotMatch(profileLoader, /setHasInvoice|setHasDeliveryNote|setInvoiceTaxPct/);
});
