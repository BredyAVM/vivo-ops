'use client';

import { useState } from 'react';
import CrmOrderValidityPanel from '../../ops/CrmOrderValidityPanel';
import CrmOrderMinimumPanel from '../../ops/CrmOrderMinimumPanel';

export default function OrderExceptionCard({ orderId, orderNumber, closed, isAdmin }: {
  orderId: number; orderNumber: string | null; closed: boolean; isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = `order-exceptions-${orderId}`;
  return <section className="space-y-3 rounded-xl border border-[#343440] p-3">
    <h2>
      <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((previous) => !previous)}
        className="flex min-h-11 w-full flex-wrap items-center justify-between gap-2 rounded-md text-left outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-amber-300">
        <span className="text-sm font-semibold text-amber-100 underline decoration-amber-200/40 underline-offset-2">Orden #{orderId} · {orderNumber}</span>
        <span className="text-xs text-amber-200">{open ? 'Cerrar detalle ↑' : 'Ver excepciones →'}</span>
      </button>
    </h2>
    <div id={panelId} hidden={!open} className="space-y-3">
    {open ? <>
      <CrmOrderValidityPanel orderId={orderId} closed={closed} />
      {!closed ? <CrmOrderMinimumPanel orderId={orderId} isAdmin={isAdmin} /> : null}
    </> : null}
    </div>
  </section>;
}
