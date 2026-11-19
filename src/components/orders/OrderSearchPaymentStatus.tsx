import { orderSearchPaymentPresentation, type OrderSearchPayment } from '@/lib/search/order-search-payments';
import { formatMasterOrderUSD } from '@/app/app/master/_components/MasterOrderDetailCore';

export default function OrderSearchPaymentStatus({ payment, cancelled, loading }: {
  payment?: OrderSearchPayment; cancelled: boolean; loading: boolean;
}) {
  const value = orderSearchPaymentPresentation(payment, cancelled, loading);
  const color = value.tone === 'pending' ? 'text-amber-300' : value.tone === 'paid' ? 'text-emerald-300' : 'text-[#8A8A96]';
  return <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
    <span className={`font-semibold ${color}`}>
      {value.label}{value.amountUsd !== null ? `: ${formatMasterOrderUSD(value.amountUsd)}` : ''}
    </span>
    {value.review ? <span className="rounded border border-amber-400/30 px-1.5 py-0.5 text-[11px] text-amber-200">Pago por revisar</span> : null}
  </div>;
}
