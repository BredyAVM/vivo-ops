export type PlayConditionsDefinition = {
  starts_at: string | null;
  ends_at: string | null;
  status: string;
  benefit_selection_mode: 'single' | 'multiple';
  purchase_requirement_mode: 'none' | 'minimum_order';
  minimum_order_amount_usd: number | string | null;
  benefit_recurrence_mode: 'once' | 'daily';
  benefit_fulfillment: 'any' | 'pickup' | 'delivery_zone_1';
};

export type PlayConditionsBenefit = {
  id: number;
  name: string;
  quantity: number;
  benefitValueUsd: number;
  advisorCostUsd: number;
  upgrades: Array<{ id: number; name: string; customerDifferenceUsd: number }>;
};

const dateFormatter = new Intl.DateTimeFormat('es-VE', {
  timeZone: 'America/Caracas', day: '2-digit', month: 'short', year: 'numeric',
});

function conditionDate(value: string | null, isEnd = false) {
  if (!value) return '';
  const isCalendarDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(isCalendarDate ? `${value}T12:00:00-04:00` : value);
  if (!Number.isFinite(date.getTime())) return '';
  // CRM closes at an exclusive instant. Midnight belongs to the preceding
  // usable day; calendar inputs already represent the inclusive last day.
  if (isEnd && !isCalendarDate) date.setTime(date.getTime() - 1);
  return dateFormatter.format(date);
}

export function playValidityLabel(play: Pick<PlayConditionsDefinition, 'starts_at' | 'ends_at'>) {
  const end = conditionDate(play.ends_at, true);
  const start = conditionDate(play.starts_at);
  if (start && end) return `${start} — ${end}`;
  if (end) return `Hasta ${end}`;
  if (start) return `Desde ${start} · sin cierre definido`;
  return 'Sin período definido';
}

export function playLastDayLabel(endsAt: string | null) {
  const end = conditionDate(endsAt, true);
  return end ? `hasta el ${end}` : 'durante esta jugada';
}

export function buildPlayConditions(play: PlayConditionsDefinition, benefits: PlayConditionsBenefit[]) {
  const hasUpgrades = benefits.some((benefit) => benefit.upgrades.length > 0);
  return [
    { label: 'Vigencia', value: playValidityLabel(play) },
    { label: 'Obsequio', value: benefits.length === 0 ? 'Pendiente de configurar'
      : benefits.length === 1 ? `${benefits[0].quantity.toLocaleString('es-VE')} × ${benefits[0].name}`
      : play.benefit_selection_mode === 'multiple' ? `Puede combinar hasta ${benefits.length} beneficios`
      : `Elige 1 de ${benefits.length} beneficios` },
    { label: 'Compra mínima', value: play.purchase_requirement_mode === 'minimum_order'
      ? `$${Number(play.minimum_order_amount_usd ?? 0).toFixed(2)} en productos · sin delivery ni obsequios`
      : 'Sin compra requerida' },
    { label: 'Uso permitido', value: play.benefit_recurrence_mode === 'daily'
      ? '1 por cliente y día de entrega · repetible en otros días'
      : 'Una vez por cliente durante la jugada' },
    { label: 'Entrega', value: play.benefit_fulfillment === 'pickup' ? 'Solo retiro en el local'
      : play.benefit_fulfillment === 'delivery_zone_1' ? 'Delivery zona 1 · confirmar el destino'
      : 'Retiro o delivery · envío según el pedido' },
    { label: 'Cambios y ampliaciones', value: hasUpgrades
      ? 'Solo opciones autorizadas · el cliente paga la diferencia'
      : 'Sin ampliaciones configuradas · no se cambia por saldo' },
  ];
}
