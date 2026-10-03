const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown) => Number(value ?? 0).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function DeliveredOrderPriceAudit({ payload }: { payload: Record<string, unknown> }) {
  const before = record(payload.before), after = record(payload.after);
  const previous = new Map((Array.isArray(before.items) ? before.items : []).map((item) => [Number(record(item).id), record(item)]));
  const items = (Array.isArray(after.items) ? after.items : []).map(record);
  return <div className="space-y-2 text-xs">
    <p>Precio cobrado al cliente · Orden entregada</p>
    <p>Total USD {amount(before.total_usd)} → {amount(after.total_usd)} · Bs {amount(before.total_bs)} → {amount(after.total_bs)}</p>
    {items.map((item) => {
      const old = previous.get(Number(item.id));
      return <div key={Number(item.id)} className="flex flex-wrap justify-between gap-2 border-t border-[#292937] pt-2">
        <span className="min-w-0 break-words">{String(item.qty)} × {String(item.product_name_snapshot || 'Producto')}</span>
        <span>USD {amount(old?.admin_price_override_usd ?? old?.override_unit_price_usd ?? old?.unit_price_usd_snapshot)} → {amount(item.admin_price_override_usd)} / unidad</span>
      </div>;
    })}
  </div>;
}
