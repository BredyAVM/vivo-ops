import type { AdvisorCrmOrderContext, MasterCrmOrderContext } from './advisor-order-context-types';

export type CrmOrderBenefitLink = {
  crmPlayMemberId?: number | null;
  crmPlayBenefitId?: number | null;
  crmPlayBenefitUpgradeId?: number | null;
};

export function resolveCrmOrderBenefit(context: AdvisorCrmOrderContext, benefitId: number, upgradeId: number | null = null) {
  const benefit = context.benefits.find((candidate) => candidate.playBenefitId === benefitId);
  if (!benefit) throw new Error('El beneficio no pertenece a esta jugada.');
  const upgrade = upgradeId == null ? null : benefit.upgrades.find((candidate) => candidate.id === upgradeId);
  if (upgradeId != null && !upgrade) throw new Error('La ampliación no pertenece a este beneficio.');
  const qty = upgrade?.quantity ?? benefit.quantity;
  const lineTotalUsd = upgrade?.customerDifferenceUsd ?? 0;
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(lineTotalUsd) || lineTotalUsd < 0) {
    throw new Error('La configuración económica del beneficio no es válida.');
  }
  return {
    crmPlayMemberId: context.playMemberId,
    crmPlayBenefitId: benefit.playBenefitId,
    crmPlayBenefitUpgradeId: upgrade?.id ?? null,
    productId: upgrade?.productId ?? benefit.productId,
    qty,
    sourcePriceCurrency: 'USD' as const,
    sourcePriceAmount: Number((lineTotalUsd / qty).toFixed(2)),
    unitPriceUsdSnapshot: Number((lineTotalUsd / qty).toFixed(2)),
    lineTotalUsd,
    crmPlayName: context.playName,
  };
}

export function validateMasterCrmBenefitSelection(input: {
  context: MasterCrmOrderContext;
  clientId: number;
  advisorUserId: string | null;
  commercialSubtotalUsd: number;
  items: Array<CrmOrderBenefitLink & { productId: number; qty: number }>;
}) {
  const { context, items } = input;
  if (context.client.id !== input.clientId || !context.advisorUserId || context.advisorUserId !== input.advisorUserId) {
    throw new Error('La jugada requiere el mismo cliente y asesor responsable de la lista.');
  }
  if (!items.length || (context.benefitSelectionMode === 'single' && items.length !== 1)) {
    throw new Error('Esta jugada permite un solo beneficio por pedido.');
  }
  if (context.purchaseRequirementMode === 'minimum_order' && input.commercialSubtotalUsd + 0.005 < Number(context.minimumOrderAmountUsd || 0)) {
    throw new Error(`La jugada requiere una compra mínima de $${Number(context.minimumOrderAmountUsd).toFixed(2)}, sin contar el beneficio.`);
  }
  const benefitIds = new Set<number>();
  for (const item of items) {
    if (item.crmPlayMemberId !== context.playMemberId || !item.crmPlayBenefitId || benefitIds.has(item.crmPlayBenefitId)) {
      throw new Error('El pedido contiene un beneficio duplicado o de otra jugada.');
    }
    benefitIds.add(item.crmPlayBenefitId);
    const choice = resolveCrmOrderBenefit(context, item.crmPlayBenefitId, item.crmPlayBenefitUpgradeId ?? null);
    if (item.productId !== choice.productId || !Number.isFinite(item.qty) || Math.abs(item.qty - choice.qty) > 0.001) {
      throw new Error('El producto o la cantidad no corresponde al beneficio seleccionado.');
    }
  }
}
