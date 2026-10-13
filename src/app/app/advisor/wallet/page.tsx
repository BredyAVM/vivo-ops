import Link from 'next/link';
import { requireAuthContext } from '@/lib/auth';
export default async function AdvisorWalletPage(){
  await requireAuthContext();
  // No issuance in block 1: never expose designs as a spendable balance.
  return <div className="space-y-3"><header><h1 className="text-xl font-semibold">Mi monedero</h1><p className="mt-1 text-xs text-[#AAB2C5]">Tus premios y sus condiciones.</p></header>
    <section className="rounded-xl border border-[#232632] bg-[#12151d] p-4"><h2 className="text-sm font-semibold">Todavía no hay premios habilitados</h2><p className="mt-2 text-xs leading-5 text-[#AAB2C5]">Estamos preparando el monedero. Los diseños del administrador no son saldo disponible. No hay aplicaciones automáticas a tus pedidos.</p></section>
    <section className="rounded-xl border border-[#232632] bg-[#12151d] p-3"><h2 className="text-sm font-semibold">Qué encontrarás aquí</h2><ul className="mt-2 space-y-2 text-xs leading-5 text-[#AAB2C5]"><li>Crédito USD separado por usos autorizados.</li><li>Unidades de productos: no se convierten en dinero.</li><li>Productos permitidos, clientes o consumo propio, y vencimiento.</li><li>Movimientos: reservado, utilizado y liberado.</li></ul></section>
    <p className="text-xs text-[#AAB2C5]">Sin efectivo ni transferencias. Amortizar deudas o ampliar productos requiere autorización expresa en las condiciones.</p>
    <Link href="/app/advisor/new" prefetch={false} className="inline-flex min-h-10 items-center rounded-lg border border-[#303040] px-3 text-sm">Ir a nuevo pedido</Link></div>;
}
