import 'server-only';
import { requireAdminContext } from '@/lib/auth';
import { searchClientSummaries } from '@/lib/search/client-search';
import { atomicConfigurationAvailable } from './capabilities';
export const CONFIG_SECTIONS = ['cuentas','tasa','delivery','usuarios','clientes'] as const;
export type ConfigSection = typeof CONFIG_SECTIONS[number];
export type ConfigRow = Record<string, unknown>;
export async function loadConfiguration(section: ConfigSection, params: Record<string,string|undefined>) {
  const { supabase } = await requireAdminContext();
  const page = Math.max(1, Math.min(10000, Math.trunc(Number(params.page) || 1)));
  const id = Number(params.id || 0);
  const queried = params.consultar === '1' || (Number.isSafeInteger(id) && id > 0);
  const atomicReady = section === 'cuentas' || section === 'usuarios' ? await atomicConfigurationAvailable() : false;
  const empty = { rows: [] as ConfigRow[], auxiliary: [] as ConfigRow[], rules: [] as ConfigRow[], profile: null as ConfigRow|null, baseline: null as ConfigRow|null, current: null as ConfigRow|null, page, hasNext: false, queried, atomicReady };
  const check = <T extends { data: unknown; error: {message:string}|null }>(result: T) => {
    if (result.error) throw new Error(result.error.message); return result.data;
  };
  if (section === 'tasa') {
    const current = check(await supabase.from('exchange_rates').select('id,rate_bs_per_usd,effective_at,is_active').eq('is_active',true).order('effective_at',{ascending:false}).limit(1).maybeSingle()) as ConfigRow|null;
    const rows = queried ? check(await supabase.from('exchange_rates').select('id,rate_bs_per_usd,effective_at,is_active,previous_rate_bs_per_usd,change_reason,created_by').order('effective_at',{ascending:false}).order('id',{ascending:false}).range((page-1)*25,page*25)) as ConfigRow[] : [];
    const ids=Array.from(new Set(rows.map(r=>r.created_by).filter(Boolean))) as string[];
    const actors=ids.length?check(await supabase.from('profiles').select('id,full_name').in('id',ids)) as ConfigRow[]:[];
    return {...empty,current,rows:rows.slice(0,25),auxiliary:actors,hasNext:rows.length>25};
  }
  if (section === 'cuentas') {
    const auxiliary = id>0 || params.nuevo==='1' ? check(await supabase.from('money_accounts').select('id,name,currency_code,account_kind,is_active').eq('account_kind','bank').eq('is_active',true).order('name').limit(200)) as ConfigRow[] : [];
    if (!queried) return {...empty,auxiliary};
    let query = supabase.from('money_accounts').select('id,name,currency_code,account_kind,institution_name,owner_name,notes,is_active').order('name').order('id');
    if (id > 0) query = query.eq('id',id);
    const rows = check(await query.range(id>0?0:(page-1)*25,id>0?0:page*25)) as ConfigRow[];
    if (!id) return {...empty,auxiliary,rows:rows.slice(0,25),hasNext:rows.length>25};
    const [r,p,b]=await Promise.all([
      supabase.from('money_account_payment_rules').select('role,payment_method_code,can_view_account,can_share_with_client,can_report_payment,can_confirm_payment,auto_confirms_report,review_required,review_roles,is_active').eq('money_account_id',id).limit(100),
      supabase.from('money_account_closure_profiles').select('money_account_id,closure_kind,default_target_money_account_id,requires_zero_difference,generates_transfer_on_close').eq('money_account_id',id).maybeSingle(),
      supabase.from('money_account_closure_baselines').select('id,baseline_date,counted_amount').eq('money_account_id',id).eq('status','active').limit(1).maybeSingle(),
    ]);
    return {...empty,auxiliary,rows,rules:check(r) as ConfigRow[],profile:check(p) as ConfigRow|null,baseline:check(b) as ConfigRow|null};
  }
  if (section === 'delivery') {
    if (!queried) return empty;
    let query=supabase.from('delivery_partners').select('id,name,partner_type,whatsapp_phone,is_active').order('name').order('id');
    if(id>0) query=query.eq('id',id);
    const rows=check(await query.range(id>0?0:(page-1)*25,id>0?0:page*25)) as ConfigRow[];
    const rules=id>0 ? check(await supabase.from('delivery_partner_rates').select('id,partner_id,km_from,km_to,price_usd,is_active').eq('partner_id',id).order('km_from').order('id').range((page-1)*25,page*25)) as ConfigRow[] : [];
    return {...empty,rows:rows.slice(0,25),rules:rules.slice(0,25),hasNext:id>0?rules.length>25:rows.length>25};
  }
  if(section==='usuarios') {
    if(!queried) return empty;
    const [profiles,roles]=await Promise.all([
      supabase.from('profiles').select('id,full_name,is_active,receives_commissions').order('full_name').order('id').range((page-1)*25,page*25),
      supabase.rpc('admin_list_user_roles'),
    ]);
    if (Array.isArray(roles.data) && roles.data.length >= 1000) throw new Error('La consulta de roles es demasiado amplia; no se muestran permisos incompletos.');
    return {...empty,rows:(check(profiles) as ConfigRow[]).slice(0,25),auxiliary:check(roles) as ConfigRow[],hasNext:(profiles.data??[]).length>25};
  }
  if(section==='clientes') {
    if(id>0) {
      const [client,advisors]=await Promise.all([
        supabase.from('clients').select('id,full_name,phone,notes,primary_advisor_id,client_type,is_active,birth_date,important_date,billing_company_name,billing_tax_id,billing_address,billing_phone,delivery_note_name,delivery_note_document_id,delivery_note_address,delivery_note_phone,recent_addresses,crm_tags').eq('id',id).maybeSingle(),
        supabase.rpc('get_advisor_profiles'),
      ]);
      const clientData=check(client);
      return {...empty,rows:clientData?[clientData as ConfigRow]:[],auxiliary:check(advisors) as ConfigRow[]};
    }
    const [rows,advisors]=await Promise.all([
      queried ? searchClientSummaries(supabase,params.q??'',20) : Promise.resolve([]),
      params.nuevo==='1' ? supabase.rpc('get_advisor_profiles') : Promise.resolve({data:[],error:null}),
    ]);
    return {...empty,rows:rows as unknown as ConfigRow[],auxiliary:check(advisors) as ConfigRow[]};
  }
  return empty;
}
