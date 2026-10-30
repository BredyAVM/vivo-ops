// @ts-nocheck
import {createClient} from '@supabase/supabase-js';
import fixture from './fixture.json';
const userId = '00000000-0000-4000-8000-000000000001';
const focusDate = '2026-10-28';
let requests = [];
let captureRequests = false;
const user = {id:userId,email:'diagnostic@example.invalid',app_metadata:{},user_metadata:{},aud:'authenticated',created_at:'2026-01-01T00:00:00Z'};
const orderValue = (r,k) => k==='extra_fields->schedule->>date' ? r.extra_fields?.schedule?.date : r[k];
function filterRows(rows,params) {
  for (const [key,value] of params) {
    if (['select','order','limit','offset'].includes(key)) continue;
    const dot=value.indexOf('.');
    const op=value.slice(0,dot), raw=value.slice(dot+1);
    const list=raw.replace(/^\(|\)$/g,'').split(',').map(x=>x.replace(/^"|"$/g,''));
    rows=rows.filter(r=>{
      const v=orderValue(r,key);
      if(op==='eq') return String(v)===raw;
      if(op==='neq') return String(v)!==raw;
      if(op==='gte') return v!=null && String(v)>=raw;
      if(op==='lt') return v!=null && String(v)<raw;
      if(op==='in') return list.includes(String(v));
      throw new Error('Unexpected read filter '+key+':'+value);
    });
  }
  if(params.has('order')) {
    const [key,dir]=params.get('order').split('.');
    rows=[...rows].sort((a,b)=>String(orderValue(a,key)).localeCompare(String(orderValue(b,key)))*(dir==='desc'?-1:1));
  }
  const total=rows.length;
  if(params.has('limit')) rows=rows.slice(0,Number(params.get('limit')));
  return {rows,total};
}
async function fakeFetch(input,init={}) {
  const u=new URL(typeof input==='string'?input:input.url||String(input));
  const method=String(init.method||'GET').toUpperCase();
  let rows, total, kind;
  if (u.hostname!=='diagnostic.invalid') throw new Error('External host blocked');
  if(u.pathname==='/auth/v1/user') { rows=user;kind='auth/user'; }
  else if(u.pathname.startsWith('/rest/v1/rpc/')) {
    const name=u.pathname.split('/').at(-1);
    if(method!=='POST') throw new Error('Unexpected RPC method');
    const args=JSON.parse(init.body||'{}');
    kind='rpc/'+name;
    if(name==='get_my_roles') rows=['admin','master'];
    else if(name==='get_driver_profiles') rows=[{user_id:'driver-fixture',full_name:'Conductor de prueba',is_active:true}];
    else if(name==='get_orders_financial_state') rows=args.p_order_ids.map(id=>{
      const r=fixture.orders.find(o=>o.id===id);
      const total=Number(r?.extra_fields?.pricing?.total_usd??r?.total_usd??0);
      return {order_id:id,total_usd:total,total_bs:total*500,confirmed_paid_usd:0,client_fund_used_usd:0,pending_usd:total,pending_bs:total*500,collection_mode:'usd',effective_operation_date:focusDate,pending_reports_count:0,confirmed_reports_count:0,rejected_reports_count:0};
    });
    else if(name==='inventory_alert_summary_v1') rows={summary:{active:15,open:12,managed:3,critical:1,requires_action:5}};
    else throw new Error('RPC blocked: '+name);
  } else {
    if(!['GET','HEAD'].includes(method)) throw new Error('Write blocked: '+method);
    const table=u.pathname.split('/').at(-1);
    kind='table/'+table;
    if(table==='profiles') rows=[{id:userId,full_name:'Operador de prueba'}];
    else if(table==='orders') rows=u.searchParams.get('select')==='id,client_id' ? fixture.clientHistory : fixture.orders;
    else if(table==='delivery_partners') rows=[{id:1,name:'Transportista de prueba',partner_type:'company_dispatch',is_active:true,whatsapp_phone:null}];
    else if(table==='inventory_counts') rows=[];
    else if(['exchange_rates','money_accounts','money_account_payment_rules'].includes(table)) rows=fixture[table];
    else throw new Error('Table not allowed: '+table);
    const filtered=filterRows(rows,u.searchParams);rows=filtered.rows;total=filtered.total;
  }
  const body=JSON.stringify(rows);
  if(captureRequests) requests.push({kind,method,path:u.pathname,filters:Object.fromEntries([...u.searchParams].filter(([k])=>k!=='select')),rowCount:Array.isArray(rows)?rows.length:1,responseBytes:Buffer.byteLength(body)});
  return new Response(method==='HEAD'?null:body,{status:200,headers:{'Content-Type':'application/json','Content-Range':`0-${Math.max(0,(rows?.length||0)-1)}/${total??rows?.length??1}`}});
}
function makeSupabase() {
  const c=createClient('https://diagnostic.invalid','fixture-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:fakeFetch}});
  const original=c.auth.getUser.bind(c.auth);
  c.auth.getUser=()=>original('fixture-token');
  return c;
}

export {makeSupabase};
