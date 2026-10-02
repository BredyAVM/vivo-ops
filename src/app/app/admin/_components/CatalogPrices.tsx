import Link from '@/components/navigation/ContextLink';
import {loadAdminCatalogPrices} from '@/lib/admin-config/catalog-prices-data';
import CatalogPricesForm from '@/components/admin/CatalogPricesForm';
import {adminPanel,AdminReadError} from './AdminReadUi';
export default async function CatalogPrices({query}:{query:Record<string,string|string[]|undefined>}){
 const page=Math.max(1,Math.min(10000,Math.trunc(Number(query.page)||1)));let data;
 try{data=await loadAdminCatalogPrices(query.consultar==='1',page);}catch{return <AdminReadError title="Precios de catálogo" message="No se pudo consultar la lista; ningún precio fue modificado."/>;}
 const href=(page:number)=>'/app/admin/inventario/prices?consultar=1&page='+page;
 return <div className="space-y-3"><h2 className="text-sm font-medium">Actualizar precios en lista</h2>{data?<section className={adminPanel}><CatalogPricesForm key={JSON.stringify(data.rows)} rows={data.rows}/><nav className="mt-3 flex justify-between gap-2 text-xs">{page>1?<Link href={href(page-1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Anterior</Link>:<span/>}<span className="content-center">Página {page}</span>{data.hasNext?<Link href={href(page+1)} prefetch={false} className="inline-flex min-h-11 items-center underline">Siguiente</Link>:<span/>}</nav></section>:<Link href={href(1)} prefetch={false} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/40 px-3 text-xs text-[#FFFF00]">Consultar precios →</Link>}</div>;
}
