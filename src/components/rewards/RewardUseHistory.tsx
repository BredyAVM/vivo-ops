import Link from 'next/link';
export type RewardUse={id:number;grant_id:number;order_id:number|null;commission_closure_id:number|null;client_name_snapshot:string|null;product_name_snapshot:string|null;purpose:string;amount:number|string;funded_usd:number|string;status:'reserved'|'used'|'released';created_at:string;
  events:{id:number;event_type:string;amount:number|string;reason:string;created_at:string}[]};
export const REWARD_USE_SELECT='id,grant_id,order_id,commission_closure_id,client_name_snapshot,product_name_snapshot,purpose,amount,funded_usd,status,created_at,events:advisor_reward_use_events(id,event_type,amount,reason,created_at)';
export default function RewardUseHistory({uses,admin=false}:{uses:RewardUse[];admin?:boolean}){
  return <section className="space-y-2"><h2 className="text-sm font-semibold">Movimientos del monedero</h2>
    {uses.length===0?<p className="text-xs text-[#AAB2C5]">Todavía no hay reservas ni consumos.</p>:null}
    {uses.slice(0,30).map(use=><details key={use.id} className="rounded-lg border border-[#292937] p-2 text-xs">
      <summary className="cursor-pointer">Premio #{use.grant_id} · {use.status==='used'?'Utilizado':use.status==='reserved'?'Reservado':'Liberado'} · ${Number(use.funded_usd).toFixed(2)} · {use.client_name_snapshot||'Deuda del asesor'}</summary>
      <div className="mt-2 space-y-2 text-[#AAB2C5]"><p>{use.product_name_snapshot} {use.order_id?<Link className="text-yellow-200" href={admin?'/app/master/ops?openOrder='+use.order_id:'/app/advisor/orders/'+use.order_id}>Orden #{use.order_id}</Link>:<Link className="text-yellow-200" href={admin?'/app/commissions/'+use.commission_closure_id:'/app/advisor/commissions'}>Cierre #{use.commission_closure_id}</Link>}</p>
        {use.events.slice().sort((a,b)=>a.id-b.id).map(event=><p key={event.id}>{new Intl.DateTimeFormat('es-VE',{timeZone:'America/Caracas',dateStyle:'short',timeStyle:'short'}).format(new Date(event.created_at))} · {event.reason}</p>)}
      </div>
    </details>)}
    {uses.length>30?<p className="text-xs text-[#AAB2C5]">Se muestran los 30 movimientos más recientes.</p>:null}
  </section>;
}
