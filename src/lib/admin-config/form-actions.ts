'use server';
import { requireAdminContext } from '@/lib/auth';
import * as commands from './canonical-actions';
import { revalidatePath } from 'next/cache';
import { ACCOUNT_RULE_METHODS, getPaymentMethodRolesForAccount } from '@/lib/payments/account-rule-policy';
import { requireAtomicConfiguration } from './capabilities';
export type ConfigurationState = { ok: boolean; message: string };
const roles = ['admin','master','advisor','kitchen','counter','driver'] as const;
type Role = typeof roles[number];
const currencies=['USD','VES'] as const;
const kinds=['bank','cash','fund','other','pos','wallet'] as const;
export async function saveConfigurationAction(_previous: ConfigurationState, form: FormData): Promise<ConfigurationState> {
  try {
    const ctx=await requireAdminContext();
    const text=(key:string)=>String(form.get(key)??'').trim();
    const number=(key:string)=>{ const raw=text(key); const value=Number(raw); if (!raw || !Number.isFinite(value)) throw new Error('Revisa los importes indicados.'); return value; };
    const id=Number(text('id')||0);
    if(!Number.isSafeInteger(id)||id<0) throw new Error('Registro inválido.');
    const active=form.get('active')==='yes';
    if (['account','rules','baseline','user','new-user'].includes(text('command'))) await requireAtomicConfiguration();
    switch(text('command')) {
      case 'rate': await commands.updateExchangeRateAction({rateBsPerUsd:number('rate'),operationId:text('operationId')}); break;
      case 'account': {
        const currency=text('currency') as typeof currencies[number], kind=text('kind') as typeof kinds[number];
        if(!currencies.includes(currency)||!kinds.includes(kind)) throw new Error('Moneda o tipo de cuenta inválido.');
        const input={operationId:text('operationId'),name:text('name'),currencyCode:currency,accountKind:kind,institutionName:text('institution'),ownerName:text('owner'),notes:text('notes'),isActive:active,closureDefaultTargetMoneyAccountId:text('target')?number('target'):null};
        if(id) {
          const {data,error}=await ctx.supabase.from('money_accounts').select('currency_code,account_kind').eq('id',id).single();
          if(error||!data) throw new Error('No se pudo verificar la cuenta.');
          if(data.currency_code!==currency||data.account_kind!==kind) throw new Error('La moneda y el tipo de una cuenta existente no se cambian desde este formulario.');
          await commands.updateMoneyAccountAction({...input,accountId:id});
        } else await commands.createMoneyAccountAction(input);
        break;
      }
      case 'rules': {
        if(!id || form.get('confirmed')!=='yes') throw new Error('Confirma la revisión de los permisos.');
        const {data:account,error}=await ctx.supabase.from('money_accounts').select('name,currency_code,account_kind').eq('id',id).single();
        if(error||!account) throw new Error('No se pudo verificar la cuenta.');
        const policy={name:account.name,currencyCode:account.currency_code,accountKind:account.account_kind};
        const rules=roles.flatMap(role=>ACCOUNT_RULE_METHODS.filter(method=>getPaymentMethodRolesForAccount(method,policy).includes(role)).map(method=>{
          const prefix=role+':'+method+':';
          const flag=(name:string)=>form.get(prefix+name)==='yes';
          const selected=form.getAll(prefix+'reviewRoles').map(String).filter(r=>roles.includes(r as Role)) as Role[];
          return {role,paymentMethodCode:method,canViewAccount:flag('view'),canShareWithClient:flag('share'),canReportPayment:flag('report'),canConfirmPayment:flag('confirm'),autoConfirmsReport:flag('auto'),reviewRequired:flag('review'),reviewRoles:selected,isActive:flag('active')};
        }));
        await commands.updateMoneyAccountPaymentRulesAction({accountId:id,rules,operationId:text('operationId')}); break;
      }
      case 'baseline':
        if(!id || form.get('confirmed')!=='yes') throw new Error('Confirma el saldo inicial contado.');
        await commands.createMoneyAccountBaselineAction({operationId:text('operationId'),moneyAccountId:id,baselineDate:text('date'),countedAmount:number('amount'),exchangeRateVesPerUsd:text('rate')?number('rate'):null,reason:text('reason'),notes:text('notes')}); break;
      case 'partner': {
        const input={name:text('name'),partnerType:text('type'),whatsappPhone:text('phone'),isActive:active};
        if(id) await commands.updateDeliveryPartnerAction({...input,partnerId:id}); else await commands.createDeliveryPartnerAction(input); break;
      }
      case 'tariff': {
        const input={kmFrom:number('from'),kmTo:text('to')?number('to'):null,priceUsd:number('amount'),isActive:active};
        if(id) await commands.updateDeliveryPartnerRateAction({...input,rateId:id}); else await commands.createDeliveryPartnerRateAction({...input,partnerId:number('partner')}); break;
      }
      case 'client': {
        // Every editable field is submitted; no invisible field is silently erased.
        const input={fullName:text('name'),phone:text('phone'),notes:text('notes'),primaryAdvisorId:text('advisor')||null,clientType:text('type'),isActive:active,birthDate:text('birth'),importantDate:text('important'),billingCompanyName:text('billingCompany'),billingTaxId:text('billingTax'),billingAddress:text('billingAddress'),billingPhone:text('billingPhone'),deliveryNoteName:text('deliveryName'),deliveryNoteDocumentId:text('deliveryDocument'),deliveryNoteAddress:text('deliveryAddress'),deliveryNotePhone:text('deliveryPhone'),recentAddresses:[{addressText:text('address0'),gpsUrl:text('gps0')},{addressText:text('address1'),gpsUrl:text('gps1')}],crmTags:text('tags').split(',').map(t=>t.trim()).filter(Boolean)};
        if(id) await commands.updateClientAction({...input,clientId:id}); else await commands.createClientAction(input); break;
      }
      case 'new-user':
        await commands.createDashboardUserAction({email:text('email'),password:String(form.get('password')??''),fullName:text('name'),isActive:active,receivesCommissions:form.get('commissions')==='yes',roles:form.getAll('roles').map(String).filter(r=>roles.includes(r as Role)) as Role[]}); break;
      case 'user': {
        const userId=text('userId');
        const selected=form.getAll('roles').map(String).filter(r=>roles.includes(r as Role)) as Role[];
        if(userId===ctx.user.id && (!active || !selected.includes('admin'))) throw new Error('Conserva tu propio acceso de administrador activo.');
        const result=await commands.updateDashboardUserAction({userId,fullName:text('name'),isActive:active,receivesCommissions:form.get('commissions')==='yes',roles:selected});
        if(!result.ok) throw new Error(result.error); break;
      }
      default: throw new Error('Operación no reconocida.');
    }
    revalidatePath('/app/admin','layout');
    return {ok:true,message:'Cambios guardados.'};
  } catch(error) {
    return {ok:false,message:error instanceof Error ? error.message : 'No se pudo guardar. Revisa el estado antes de repetir.'};
  }
}
