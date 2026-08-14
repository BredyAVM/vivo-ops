type JsonRecord = Record<string, unknown>;

export type AdvisorCommissionConformityState =
  | { status: 'pending' }
  | {
      status: 'confirmed';
      confirmedAt: string;
      recordedByUserId: string;
      source: 'admin-recorded';
    }
  | {
      status: 'requires_reconfirmation';
      supersededAt: string;
      supersededByUserId: string;
      reason: string;
    };

export type AdvisorCommissionWorkflowState = {
  conformity: AdvisorCommissionConformityState;
  revisionCount: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isoTimestamp(value: string, field: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} debe ser una fecha y hora válida.`);
  }
  return new Date(value).toISOString();
}

function requiredText(value: string, field: string, maxLength = 500) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} es obligatorio.`);
  if (normalized.length > maxLength) {
    throw new Error(`${field} no puede superar ${maxLength} caracteres.`);
  }
  return normalized;
}

export function readAdvisorCommissionWorkflowSnapshot(
  snapshot: unknown
): AdvisorCommissionWorkflowState {
  const workflow = record(record(snapshot).commissionWorkflow);
  const conformity = record(workflow.conformity);
  const revisions = Array.isArray(workflow.revisions) ? workflow.revisions : [];

  if (
    conformity.status === 'confirmed' &&
    typeof conformity.confirmedAt === 'string' &&
    typeof conformity.recordedByUserId === 'string'
  ) {
    return {
      conformity: {
        status: 'confirmed',
        confirmedAt: conformity.confirmedAt,
        recordedByUserId: conformity.recordedByUserId,
        source: 'admin-recorded',
      },
      revisionCount: revisions.length,
    };
  }

  if (
    conformity.status === 'requires_reconfirmation' &&
    typeof conformity.supersededAt === 'string' &&
    typeof conformity.supersededByUserId === 'string' &&
    typeof conformity.reason === 'string'
  ) {
    return {
      conformity: {
        status: 'requires_reconfirmation',
        supersededAt: conformity.supersededAt,
        supersededByUserId: conformity.supersededByUserId,
        reason: conformity.reason,
      },
      revisionCount: revisions.length,
    };
  }

  return { conformity: { status: 'pending' }, revisionCount: revisions.length };
}

export function confirmAdvisorCommissionWorkflowSnapshot(input: {
  snapshot: unknown;
  confirmedAt: string;
  recordedByUserId: string;
}) {
  const snapshot = record(input.snapshot);
  const workflow = record(snapshot.commissionWorkflow);

  return {
    ...snapshot,
    commissionWorkflow: {
      ...workflow,
      version: 1,
      conformity: {
        status: 'confirmed',
        confirmedAt: isoTimestamp(input.confirmedAt, 'confirmedAt'),
        recordedByUserId: requiredText(input.recordedByUserId, 'recordedByUserId', 100),
        source: 'admin-recorded',
      },
    },
  };
}

export function reopenAdvisorCommissionWorkflowSnapshot(input: {
  snapshot: unknown;
  reopenedAt: string;
  reopenedByUserId: string;
  reason: string;
}) {
  const snapshot = record(input.snapshot);
  const workflow = record(snapshot.commissionWorkflow);
  const previousConformity = record(workflow.conformity);
  const revisions = Array.isArray(workflow.revisions) ? workflow.revisions : [];
  const reopenedAt = isoTimestamp(input.reopenedAt, 'reopenedAt');
  const reopenedByUserId = requiredText(input.reopenedByUserId, 'reopenedByUserId', 100);
  const reason = requiredText(input.reason, 'El motivo');

  return {
    ...snapshot,
    commissionWorkflow: {
      ...workflow,
      version: 1,
      conformity: {
        status: 'requires_reconfirmation',
        supersededAt: reopenedAt,
        supersededByUserId: reopenedByUserId,
        reason,
      },
      revisions: [
        ...revisions,
        {
          reopenedAt,
          reopenedByUserId,
          reason,
          previousConformity,
        },
      ].slice(-20),
    },
  };
}

export function preserveAdvisorCommissionWorkflowSnapshot(input: {
  generatedSnapshot: unknown;
  previousSnapshot: unknown;
}) {
  const generatedSnapshot = record(input.generatedSnapshot);
  const previousWorkflow = record(input.previousSnapshot).commissionWorkflow;
  if (!isRecord(previousWorkflow)) return generatedSnapshot;

  return {
    ...generatedSnapshot,
    commissionWorkflow: previousWorkflow,
  };
}
