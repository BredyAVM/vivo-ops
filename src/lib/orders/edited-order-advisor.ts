export function resolveEditedOrderAdvisor(input: {
  source: 'advisor' | 'master' | 'walk_in';
  currentAdvisorId: string | null;
  selectedAdvisorId: string | null;
  hasCrmBenefit: boolean;
}) {
  if (input.source === 'advisor' || input.hasCrmBenefit) {
    const selected = input.selectedAdvisorId?.trim();
    if (!selected) throw new Error('Debes seleccionar un asesor.');
    return selected;
  }

  // An operational edit is not an assignment. Counter assignments keep their separate flow.
  return input.currentAdvisorId;
}
