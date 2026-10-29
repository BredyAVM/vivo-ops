import {readMuerdemeIncentiveSnapshot}from'@/lib/brands/order-incentives';
const usd=new Intl.NumberFormat('es-VE',{style:'currency',currency:'USD',currencyDisplay:'code'});
export default function MuerdemeIncentiveBreakdown({snapshot}:{snapshot:unknown}){
 const value=readMuerdemeIncentiveSnapshot(snapshot);if(!value.rows.length)return null;
 return<section className="min-w-0 rounded-xl border border-[#343442] bg-[#111117] p-3 text-xs"aria-label="Estímulos por hamburguesas">
  <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium text-[#DEDEE6]">Estímulos por hamburguesas</h3><span className="font-medium tabular-nums text-[#FFFF00]">{usd.format(value.totalUsd)} · {value.rows.length} pedidos</span></div>
  <p className="mt-1 text-[11px] text-[#BDBDC7]">Un importe por pedido entregado y cobrado, independientemente de cuántas hamburguesas lleve. Incluido en la comisión bruta.</p>
  <details className="mt-2"><summary className="min-h-11 cursor-pointer content-center text-[#FFFF00] md:min-h-8">Ver pedidos y tarifas aplicadas</summary>
   <div className="divide-y divide-[#30303D]">{value.rows.map(row=><div key={row.orderId}className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2 text-[#DEDEE6]">
    <span>#{row.orderNumber} · {row.purchaseKind==='first'?'Primera compra':'Recurrente'}<span className="ml-2 text-[11px] text-[#BDBDC7]">{row.deliveryDate} · Tarifa v{row.policyRevision}</span></span><span className="tabular-nums">{usd.format(row.amountUsd)}</span>
   </div>)}</div></details>
 </section>;
}
