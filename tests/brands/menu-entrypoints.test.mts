import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { menuDocument } from './menu-fixtures.ts';
import { menuRoot } from '../../src/lib/brands/menu-model.ts';
const stub='data:text/javascript,'+encodeURIComponent(`
export const calls=[];export let denied=false;export let response={data:null,error:null};
export function reset(){calls.length=0;denied=false;response={data:null,error:null};}
export function configure(r){response=r;}export function deny(){denied=true;}
export async function requireAdminContext(){calls.push(['auth']);if(denied)throw new Error('No autorizado.');return{supabase:{rpc:async(name,args)=>{calls.push(['rpc',name,args]);return response;}}};}
export function revalidatePath(path){calls.push(['refresh',path]);}
export function redirect(path){throw new Error('REDIRECT:'+path);}
`);
const registerHooks=Reflect.get(nodeModule,'registerHooks') as(hooks:{resolve(s:string,c:{parentURL?:string},next:(s:string,c:{parentURL?:string})=>{url:string;shortCircuit?:boolean}):{url:string;shortCircuit?:boolean}})=>void;
registerHooks({resolve(s,c,next){
  if(['@/lib/auth','next/cache','next/navigation'].includes(s))return{url:stub,shortCircuit:true};
  if(s==='server-only')return{url:'data:text/javascript,export{}',shortCircuit:true};
  if(s==='@/lib/navigation/return-navigation')return next(new URL('../../src/lib/navigation/return-navigation.ts',import.meta.url).href,c);
  if(s==='./menu-model'&&c.parentURL?.includes('/lib/brands/'))return next('./menu-model.ts',c);
  return next(s,c);
}});
const control=await import(stub);
const {loadMuerdemeMenuList,loadMuerdemeMenuEditor}=await import('../../src/lib/brands/menu-data.ts');
const {saveMuerdemeMenuDraft}=await import('../../src/lib/brands/menu-actions.ts');
const savedId='00000000-0000-4000-8000-000000000020';
const form=()=>{const f=new FormData();f.set('document',JSON.stringify(menuDocument('drink','Ensayo Bebida',null)));f.set('entryId','');f.set('revision','0');f.set('operationId','00000000-0000-4000-8000-000000000010');return f;};
test('catalogue landing authenticates without any data query',async()=>{
  control.reset();assert.equal(await loadMuerdemeMenuList({}),null);assert.deepEqual(control.calls,[['auth']]);
});
test('invalid catalogue filters and direct action calls fail before data access',async()=>{
  control.reset();await assert.rejects(()=>loadMuerdemeMenuList({consultar:'1',tipo:'vivo'}),/filtros/);assert.deepEqual(control.calls,[['auth']]);
  control.reset();control.deny();assert.equal((await saveMuerdemeMenuDraft({error:''},form())).error,'No autorizado.');assert.deepEqual(control.calls,[['auth']]);
});
test('editor requests only its scoped reference search and no VIVO or financial command',async()=>{
  control.reset();control.configure({data:{version:'muerdeme-menu-v1',entry:null,lookups:[],lookupHasMore:false},error:null});
  const data=await loadMuerdemeMenuEditor(null,'extra');assert.equal(data!.lookups.length,0);
  assert.deepEqual(control.calls,[['auth'],['rpc','admin_muerdeme_menu_editor_v1',{p_entry_id:null,p_kind:'extra',p_reference_query:''}]]);
});
test('successful draft creation redirects to its new entry and preserves the catalogue filters',async()=>{
  control.reset();control.configure({data:{entryId:savedId,revision:1},error:null});const f=form();
  f.set('returnTo',menuRoot+'?consultar=1&tipo=drink');
  await assert.rejects(()=>saveMuerdemeMenuDraft({error:''},f),error=>{
    const url=new URL((error as Error).message.replace('REDIRECT:',''),'https://vivo.test');
    assert.equal(url.pathname,menuRoot+'/'+savedId);assert.equal(url.searchParams.get('returnTo'),menuRoot+'?consultar=1&tipo=drink');return true;
  });
  assert.equal(control.calls.filter((c:string[])=>c[0]==='rpc').length,1);
  assert.ok(control.calls.filter((c:string[])=>c[0]==='refresh').every((c:string[])=>c[1].startsWith(menuRoot)));
});
test('foreign return routes cannot redirect an administrative catalogue save',async()=>{
  for(const returnTo of ['https://evil.test','/app/master/dashboard']){
    control.reset();control.configure({data:{entryId:savedId,revision:1},error:null});const f=form();f.set('returnTo',returnTo);
    await assert.rejects(()=>saveMuerdemeMenuDraft({error:''},f),error=>{
      const url=new URL((error as Error).message.replace('REDIRECT:',''),'https://vivo.test');assert.equal(url.searchParams.get('returnTo'),menuRoot);return true;
    });
  }
});
test('server rejects unknown fields and does not report success for an uncertain write',async()=>{
  control.reset();const f=form();f.set('document',JSON.stringify({...menuDocument('drink','Ensayo'),brand:'vivo'}));
  assert.match((await saveMuerdemeMenuDraft({error:''},f)).error,/campos no admitidos/);assert.deepEqual(control.calls,[['auth']]);
  for(const response of [{data:null,error:{code:'40001',message:'internal'}},{data:null,error:{code:'other',message:'secret SQL'}},{data:null,error:null}]){
    control.reset();control.configure(response);const result=await saveMuerdemeMenuDraft({error:''},form());
    assert.ok(result.error);assert.doesNotMatch(result.error,/secret SQL|internal/);assert.equal(control.calls.some((c:string[])=>c[0]==='refresh'),false);
  }
});
