'use client';

import { useState } from 'react';
import CrmOrderValidityPanel from '../../ops/CrmOrderValidityPanel';
import CrmOrderMinimumPanel from '../../ops/CrmOrderMinimumPanel';

export default function OrderExceptionCard({ orderId, orderNumber, closed, isAdmin }: {
  orderId: number; orderNumber: string | null; closed: boolean; isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <section className="space-y-3 rounded-xl border border-[#343440] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">Orden #{orderId} · {orderNumber}</h2>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="text-xs text-amber-200 underline">
        {open ? 'Cerrar detalle' : 'Ver excepciones'}
      </button>
    </div>
    {open ? <>
      <CrmOrderValidityPanel orderId={orderId} closed={closed} />
      {!closed ? <CrmOrderMinimumPanel orderId={orderId} isAdmin={isAdmin} /> : null}
    </> : null}
  </section>;
}
