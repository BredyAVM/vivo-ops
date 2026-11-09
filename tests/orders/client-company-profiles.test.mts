import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { canApplyDefaultCompany, companyDocumentSignature, normalizeCompanyDocumentData } from '../../src/lib/clients/company-profiles.ts';
import { clientDocumentProfilePatch } from '../../src/lib/clients/document-profile.ts';

test('saved companies use eight independent document fields, without document or IVA flags', () => {
  const data = normalizeCompanyDocumentData({invoiceCompanyName:' Empresa A ',invoiceTaxId:' J-123 '});
  assert.equal(data.invoiceCompanyName,'Empresa A');
  assert.equal(data.invoiceTaxId,'J-123');
  assert.equal(Object.keys(data).length,8);
  assert.equal(data.deliveryNoteName,'');
  assert.equal(companyDocumentSignature(data),companyDocumentSignature({...data,invoiceCompanyName:'Empresa A'}));
});

test('defaults cannot overwrite drafts, historical snapshots or edits made while loading', () => {
  assert.equal(canApplyDefaultCompany(true,'original','original'),true);
  assert.equal(canApplyDefaultCompany(false,'original','original'),false);
  assert.equal(canApplyDefaultCompany(true,'original','edited while loading'),false);
});

test('managed company flow never implicitly updates the legacy client document profile', () => {
  assert.deepEqual(clientDocumentProfilePatch({hasInvoice:true,hasDeliveryNote:true,
    preserveClientCommercialProfile:true,invoiceCompanyName:'Empresa B',deliveryNoteName:'Empresa B'}),{});
});

test('both master order writers snapshot submitted company, not the legacy principal', () => {
  const source = readFileSync(new URL('../../src/app/app/master/dashboard/actions.ts',import.meta.url),'utf8');
  const tree = ts.createSourceFile('actions.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
  const snapshots: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === 'documents') snapshots.push(node.initializer.getText(tree));
    ts.forEachChild(node,visit);
  }
  visit(tree);
  assert.equal(snapshots.length,2);
  for (const snapshot of snapshots) {
    const exports: {build?: (input: unknown) => {invoice_snapshot: {tax_id:string};delivery_note_snapshot:{document_id:string}}} = {};
    runInNewContext(ts.transpileModule('export const build = input => ('+snapshot+');',
      {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports,normalizePhone:(value:string)=>value});
    const docs = exports.build!({hasInvoice:true,hasDeliveryNote:true,invoiceDataNote:'',
      invoiceCompanyName:'Empresa B',invoiceTaxId:'J-B',invoiceAddress:'B',invoicePhone:'',
      deliveryNoteName:'Empresa B',deliveryNoteDocumentId:'J-B',deliveryNoteAddress:'B',deliveryNotePhone:''});
    assert.equal(docs.invoice_snapshot.tax_id,'J-B');
    assert.equal(docs.delivery_note_snapshot.document_id,'J-B');
  }
});
