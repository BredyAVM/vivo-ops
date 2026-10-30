import { formatOrderDisplayLabel } from './order-labels.ts';

type PushOutcome = {
  skipped: boolean;
  delivered?: number;
  failures?: unknown[];
};

export type CreationPushStatus = 'sent' | 'partial' | 'failed' | 'skipped' | 'uncertain';
export type CreationPushReceipt = {
  eventId: number;
  claimId: string;
  status: CreationPushStatus;
  delivered: number;
  failures: number;
};

type CreationPushDependencies = {
  claim: () => Promise<{ claimed: boolean; eventId?: number }>;
  send: (input: {
    roles: string[]; title: string; body: string; url: string; tag: string;
    tone: 'critical'; requireInteraction: boolean;
  }) => Promise<PushOutcome>;
  finish: (receipt: CreationPushReceipt) => Promise<void>;
  report: (result: { orderId: number; eventId: number; status: string; delivered: number; failures: number }) => void;
};

// The durable SQL claim, not the web-push tag or an in-memory flag, deduplicates.
export async function deliverAdvisorCreatedPush(
  input: { orderId: number; claimId: string },
  dependencies: CreationPushDependencies,
) {
  const claim = await dependencies.claim();
  if (!claim.claimed) return;
  const eventId = Number(claim.eventId);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new Error('Invalid creation event receipt.');
  let status: CreationPushStatus = 'uncertain';
  let delivered = 0;
  let failures = 0;
  try {
    const outcome = await dependencies.send({
      roles: ['master', 'admin'],
      title: `${formatOrderDisplayLabel(input.orderId)}: Orden creada`,
      body: 'La orden fue creada por un asesor y requiere aprobación.',
      url: `/app/master/ops?openOrder=${input.orderId}&tab=pedido`,
      tag: `master-order-${input.orderId}-order_created`,
      tone: 'critical',
      requireInteraction: true,
    });
    delivered = Math.max(0, Math.trunc(Number(outcome.delivered) || 0));
    failures = outcome.failures?.length ?? 0;
    status = delivered > 0 ? (failures > 0 ? 'partial' : 'sent') : failures > 0 ? 'failed' : 'skipped';
  } catch {
    // A timeout does not prove non-delivery. Never send a second broadcast here.
    failures = 1;
  }
  dependencies.report({ orderId: input.orderId, eventId, status, delivered, failures });
  await dependencies.finish({ eventId, claimId: input.claimId, status, delivered, failures });
}

