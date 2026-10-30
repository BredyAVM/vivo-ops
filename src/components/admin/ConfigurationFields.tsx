import type { InputHTMLAttributes } from 'react';
import ConfigurationForm from './ConfigurationForm';
import { queryControl } from '@/components/ui/QueryControls';
import { currencyLabel } from '@/lib/ui/currency-label';
import { getPaymentMethodLabel } from '@/lib/orders/order-labels';
import { ACCOUNT_RULE_METHODS, ACCOUNT_RULE_ROLES, getPaymentMethodRolesForAccount } from '@/lib/payments/account-rule-policy';
import type { ConfigRow } from '@/lib/admin-config/data';
const field=queryControl;
const grid='grid min-w-0 gap-3 sm:grid-cols-2';
const kinds={bank:'Banco',cash:'Caja',fund:'Fondo',other:'Otra',pos:'Punto de venta',wallet:'Wallet'};
const roleNames={admin:'Administrador',master:'Master',advisor:'Asesor',kitchen:'Cocina',counter:'Caja',driver:'Motorizado'};
export function Input({label,name,value,...props}:{label:string;name:string;value?:unknown}&Omit<InputHTMLAttributes<HTMLInputElement>,'defaultValue'|'value'>) {
  return <label className="grid min-w-0 gap-1 text-xs text-[#BDBDC7]">{label}<input {...props} name={name} defaultValue={String(value??'')} className={field}/></label>;
}
function Check({name,label,value=false}:{name:string;label:string;value?:boolean}) { return <label className="inline-flex min-h-11 items-center gap-2 text-xs"><input name={name} type="checkbox" value="yes" defaultChecked={value}/>{label}</label>; }
export function AccountForm({row={},banks=[],target=null}:{row?:ConfigRow;banks?:ConfigRow[];target?:unknown}) {
  const id=Number(row.id)||0;
  return <ConfigurationForm command="account" id={id}><div className={grid}>
    <Input name="name" label="Nombre de la cuenta" value={row.name} required maxLength={150}/>
    {id?<><Input name="currency" label="Moneda" value={row.currency_code} readOnly/><Input name="kind" label="Tipo (se conserva)" value={row.account_kind} readOnly/></>:<>
      <label className="grid gap-1">Moneda<select name="currency" className={field} defaultValue="VES"><option value="VES">Bolívares</option><option value="USD">Dólares</option></select></label>
      <label className="grid gap-1">Tipo<select name="kind" className={field} defaultValue="bank">{Object.entries(kinds).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label></>}
    <Input name="institution" label="Institución" value={row.institution_name}/><Input name="owner" label="Titular" value={row.owner_name}/>
    <Input name="notes" label="Notas" value={row.notes} maxLength={1000}/>
    <label className="grid gap-1">Banco destino del cierre (solo punto)<select name="target" className={field} defaultValue={String(target??'')}><option value="">Sin destino</option>{banks.map(b=><option key={String(b.id)} value={String(b.id)}>{String(b.name)} · {String(b.currency_code)}</option>)}</select></label>
  </div><Check name="active" label="Cuenta activa" value={row.is_active!==false}/></ConfigurationForm>;
}
export function AccountRulesForm({row,rules}:{row:ConfigRow;rules:ConfigRow[]}) {
  const account={name:String(row.name),currencyCode:String(row.currency_code),accountKind:String(row.account_kind)};
  const fields=[['active','is_active','Activa'],['view','can_view_account','Ver cuenta'],['share','can_share_with_client','Compartir'],['report','can_report_payment','Reportar'],['confirm','can_confirm_payment','Confirmar'],['auto','auto_confirms_report','Confirmar automáticamente'],['review','review_required','Requiere revisión']] as const;
  return <ConfigurationForm command="rules" id={Number(row.id)} submitLabel="Guardar permisos de pago">
    {ACCOUNT_RULE_ROLES.map(role=>{
      const methods=ACCOUNT_RULE_METHODS.filter(method=>getPaymentMethodRolesForAccount(method,account).includes(role));
      if(!methods.length)return null;
      return <details key={role} className="rounded-lg border border-[#30303D] px-3"><summary className="min-h-11 cursor-pointer content-center">{roleNames[role]}</summary>
        <div className="mb-3 space-y-3">{methods.map(method=>{
          const rule=rules.find(r=>r.role===role&&r.payment_method_code===method)??{};
          const prefix=role+':'+method+':';
          const reviews=Array.isArray(rule.review_roles)?rule.review_roles:[];
          return <div key={method} className="rounded-lg bg-[#181820] p-3"><h3 className="font-medium text-[#DEDEE6]">{getPaymentMethodLabel(method)}</h3><div className="flex flex-wrap gap-x-4">{fields.map(([name,key,label])=><Check key={name} name={prefix+name} label={label} value={rule[key]===true}/>)}</div>
            <details><summary className="min-h-11 cursor-pointer content-center text-[#9B9BA7]">Quién revisa</summary><div className="flex flex-wrap gap-3">{ACCOUNT_RULE_ROLES.map(reviewRole=><label key={reviewRole} className="inline-flex min-h-11 items-center gap-2"><input type="checkbox" name={prefix+'reviewRoles'} value={reviewRole} defaultChecked={reviews.includes(reviewRole)}/>{roleNames[reviewRole]}</label>)}</div></details></div>;
        })}</div></details>;
    })}
    <label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="confirmed" value="yes" required/>Revisé los permisos que se guardarán.</label>
  </ConfigurationForm>;
}
export function BaselineForm({row}:{row:ConfigRow}) { return <ConfigurationForm command="baseline" id={Number(row.id)} submitLabel="Guardar saldo inicial"><p className="text-xs text-orange-200">Solo para una cuenta sin línea base. No sustituye un cierre ni una conciliación bancaria.</p><div className={grid}><Input name="date" label="Fecha del saldo inicial" type="date" required/><Input name="amount" label={'Saldo contado · '+currencyLabel(String(row.currency_code))} type="number" min="0" step="0.01" required/>{row.currency_code==='VES'?<Input name="rate" label="Tasa Bs/USD de esa fecha" type="number" min="0.000001" step="0.000001" required/>:null}<Input name="reason" label="Motivo" required minLength={3} maxLength={500}/><Input name="notes" label="Notas" maxLength={1000}/></div><label className="flex min-h-11 items-center gap-2"><input type="checkbox" name="confirmed" value="yes" required/>Confirmo este saldo inicial contado.</label></ConfigurationForm>; }
export function RateForm({current}:{current:ConfigRow|null}) {return <ConfigurationForm command="rate" submitLabel="Actualizar tasa"><div className="max-w-xs"><Input name="rate" label="Tasa general Bs/USD" value={current?.rate_bs_per_usd} required type="number" min="0.000001" step="0.000001"/></div><p className="text-[11px] text-[#9B9BA7]">Motivo automático: actualización diaria. Se conservan tasa anterior, nueva, usuario y hora.</p></ConfigurationForm>; }
export function PartnerForm({row={}}:{row?:ConfigRow}) {return <ConfigurationForm command="partner" id={Number(row.id)||0}><div className={grid}><Input name="name" label="Empresa o motorizado externo" value={row.name} required/><Input name="phone" label="WhatsApp" value={row.whatsapp_phone}/><label className="grid gap-1">Tipo<select name="type" defaultValue={String(row.partner_type??'company_dispatch')} className={field}><option value="company_dispatch">Empresa de delivery</option><option value="direct_driver">Motorizado externo directo</option></select></label></div><Check name="active" label="Activo" value={row.is_active!==false}/></ConfigurationForm>; }
export function TariffForm({partner,row={}}:{partner:number;row?:ConfigRow}) {return <ConfigurationForm command="tariff" id={Number(row.id)||0}><input type="hidden" name="partner" value={partner}/><div className={grid}><Input name="from" label="Desde km" value={row.km_from??0} type="number" step="0.01" min="0" required/><Input name="to" label="Hasta km (vacío: sin límite)" value={row.km_to} type="number" step="0.01" min="0"/><Input name="amount" label="Tarifa USD" value={row.price_usd} type="number" step="0.01" min="0" required/></div><Check name="active" label="Tarifa activa" value={row.is_active!==false}/></ConfigurationForm>; }
export function ClientForm({row={},advisors=[]}:{row?:ConfigRow;advisors?:ConfigRow[]}) {
  const addresses=Array.isArray(row.recent_addresses)?row.recent_addresses as ConfigRow[]:[];
  return <ConfigurationForm command="client" id={Number(row.id)||0}><div className={grid}><Input name="name" label="Nombre" value={row.full_name} required/><Input name="phone" label="Teléfono" value={row.phone}/><Input name="type" label="Tipo de cliente" value={row.client_type}/><label className="grid gap-1">Asesor principal<select name="advisor" className={field} defaultValue={String(row.primary_advisor_id??'')}><option value="">Sin asesor asignado</option>{advisors.map(a=><option key={String(a.user_id)} value={String(a.user_id)}>{String(a.full_name??'Asesor')}</option>)}</select></label><Input name="notes" label="Notas" value={row.notes}/><Input name="tags" label="Etiquetas CRM (separadas por coma)" value={Array.isArray(row.crm_tags)?row.crm_tags.join(', '):''}/></div>
    <Check name="active" label="Cliente activo" value={row.is_active!==false}/>
    <details><summary className="min-h-11 cursor-pointer content-center">Fechas, direcciones y datos fiscales</summary><div className={grid}><Input name="birth" label="Nacimiento" value={row.birth_date} type="date"/><Input name="important" label="Fecha importante" value={row.important_date} type="date"/>
    {[[ 'billingCompany','billing_company_name','Empresa'],['billingTax','billing_tax_id','RIF'],['billingAddress','billing_address','Dirección fiscal'],['billingPhone','billing_phone','Teléfono fiscal'],['deliveryName','delivery_note_name','Nombre para entrega'],['deliveryDocument','delivery_note_document_id','Documento'],['deliveryAddress','delivery_note_address','Dirección de entrega'],['deliveryPhone','delivery_note_phone','Teléfono de entrega']].map(([name,key,label])=><Input key={name} name={name} label={label} value={row[key]}/>)}
    {[0,1].map(i=><div key={i} className="space-y-3"><Input name={'address'+i} label={'Dirección reciente '+(i+1)} value={addresses[i]?.address_text}/><Input name={'gps'+i} label="Enlace GPS" value={addresses[i]?.gps_url}/></div>)}</div></details>
  </ConfigurationForm>;
}
export function UserForm({row,roles}:{row:ConfigRow;roles:string[]}) {return <ConfigurationForm command="user"><input type="hidden" name="userId" value={String(row.id)}/><Input name="name" label="Nombre" value={row.full_name} required/><div className="flex flex-wrap gap-3">{ACCOUNT_RULE_ROLES.map(role=><label key={role} className="inline-flex min-h-11 items-center gap-2"><input name="roles" value={role} type="checkbox" defaultChecked={roles.includes(role)}/>{roleNames[role]}</label>)}</div><div className="flex flex-wrap gap-3"><Check name="active" label="Usuario activo" value={row.is_active!==false}/><Check name="commissions" label="Recibe comisiones como asesor" value={row.receives_commissions===true}/></div></ConfigurationForm>; }
export function NewUserForm() {return <ConfigurationForm command="new-user" submitLabel="Crear usuario"><div className={grid}><Input name="name" label="Nombre" required/><Input name="email" label="Correo" type="email" required autoComplete="off"/><Input name="password" label="Contraseña inicial" type="password" minLength={6} required autoComplete="new-password"/></div><div className="flex flex-wrap gap-3">{ACCOUNT_RULE_ROLES.map(role=><label key={role} className="inline-flex min-h-11 items-center gap-2"><input name="roles" value={role} type="checkbox"/>{roleNames[role]}</label>)}</div><Check name="active" label="Usuario activo" value/><Check name="commissions" label="Recibe comisiones como asesor"/></ConfigurationForm>; }
