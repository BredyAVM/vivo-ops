export type RewardOrderFunding = {orderItemId:number;title:string;status:'reserved'|'used';purpose:string;fundedUsd:number};
export default function RewardOrderBadge({funding}:{funding?:RewardOrderFunding}) {
  if(!funding)return null;
  return <p className="mt-1 rounded-md border border-emerald-500/25 bg-emerald-950/20 px-2 py-1 text-[11px] text-emerald-200">
    Premio {funding.status==='used'?'consumido':'reservado'}: {funding.title} · Financia ${Number(funding.fundedUsd).toFixed(2)}
    {funding.purpose==='personal_purchase'?' · Consumo propio':' · Obsequio al cliente'}
  </p>;
}
