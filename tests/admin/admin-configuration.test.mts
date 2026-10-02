import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isPaymentMethodApplicableToAccount,getPaymentMethodRolesForAccount} from '../../src/lib/payments/account-rule-policy.ts';
const src=(p:string)=>readFileSync(p,'utf8');
test('shared account policy matches existing financial methods and role eligibility',()=>{
 assert.deepEqual(getPaymentMethodRolesForAccount('cash_usd',{name:'Caja',currencyCode:'USD',accountKind:'cash'}),['admin','master','counter','driver']);
 assert.equal(isPaymentMethodApplicableToAccount('payment_mobile',{name:'Banco',currencyCode:'VES',accountKind:'bank'}),true);
 assert.equal(isPaymentMethodApplicableToAccount('cash_ves',{name:'Caja',currencyCode:'USD',accountKind:'cash'}),false);
 assert.deepEqual(getPaymentMethodRolesForAccount('retention',{name:'Retención',currencyCode:'VES',accountKind:'bank'}),['admin','master']);
});
test('configuration routes do not import or mount the legacy dashboard',()=>{
 const page=src('src/app/app/admin/configuracion/[section]/page.tsx');
 assert.match(page,/requireAdminContext/);assert.doesNotMatch(page,/MasterDashboardClient|import[^;]+master\/dashboard/);
 assert.match(page,/!data.atomicReady/);assert.match(page,/Modificar en Administrador anterior/);
 const load=src('src/lib/admin-config/data.ts');
 assert.match(load,/if\(!queried\) return empty/);assert.match(load,/range\(/);assert.match(load,/params.nuevo==='1'/);
 assert.match(load,/created_by/);assert.match(load,/profiles/);
});
test('configuration fields preserve advanced client data and immutable account currency/type',()=>{
 const s=src('src/lib/admin-config/form-actions.ts');
 for(const key of ['billingCompanyName','billingTaxId','deliveryNoteName','recentAddresses','crmTags','primaryAdvisorId'])assert.match(s,new RegExp(key));
 assert.match(s,/data.currency_code!==currency\|\|data.account_kind!==kind/);
 assert.match(s,/userId===ctx.user.id/);
});
test('new financial configuration commands are atomic, session authorized and replayable',()=>{
 const s=src('src/lib/admin-config/canonical-actions.ts');
 for(const name of ['admin_account_configuration_v1','admin_account_rules_v1','admin_account_baseline_v1','admin_user_configuration_v1'])assert.match(s,new RegExp(name));
 const sql=src('docs/proposals/admin_configuration_atomic.NOT_APPLIED.sql');
 assert.match(sql,/security definer set search_path=''/);assert.match(sql,/assert_configuration_admin_v1/);
 assert.match(sql,/request_payload<>p_input/);assert.match(sql,/request_payload<>v_request/);assert.match(sql,/pg_advisory_xact_lock/);
 assert.match(sql,/for update/);assert.match(sql,/sum\(case when direction='inflow'/);
 assert.match(sql,/revoke all on function public.admin_account_rules_v1\(bigint,jsonb,uuid\) from public,anon,authenticated,service_role/);
 assert.match(sql,/v_id=v_uid/);assert.match(sql,/jsonb_typeof\(p_rules\) is distinct from 'array'/);
});
test('form retries retain identity for unchanged payload and cannot double-submit fields',()=>{
 const s=src('src/components/admin/ConfigurationForm.tsx');
 assert.match(s,/attempt.current.payload!==payload/);assert.match(s,/form.set\('operationId',attempt.current.id\)/);
 assert.match(s,/if\(result.ok\)attempt.current=null/);assert.match(s,/fieldset disabled=\{pending\|\|unavailable\}/);
});
test('new user creation compensates only the newly returned Auth ID and never exposes service keys',()=>{
 const s=src('src/lib/admin-config/canonical-actions.ts');
 assert.match(s,/const userId=created.data.user.id/);assert.match(s,/deleteUser\(userId\)/);
 assert.match(s,/ctx.supabase.rpc\('admin_user_configuration_v1'/);
 assert.doesNotMatch(src('src/components/admin/ConfigurationFields.tsx'),/SERVICE_ROLE|auth.admin/);
 const api=src('src/app/api/admin/create-user/route.ts');
 assert.match(api,/profile\?\.is_active/);assert.match(api,/roles.some\(r=>r==='admin'\|\|r==='master'\)/);
});
test('delivery and notification entry do not automatically generate histories or test sends',()=>{
 const s=src('src/app/app/admin/finanzas/delivery/page.tsx');
 assert.ok(s.indexOf('if(!requested)return')<s.indexOf('loaded = await loadDeliveryServices'));
 const push=src('src/components/notifications/OperationsPushPanel.tsx');
 assert.match(push,/url: targetUrl/);assert.match(push,/if\(!response.ok\)throw new Error/);
 assert.match(src('src/app/app/admin/notificaciones/page.tsx'),/requireAdminContext/);
});
