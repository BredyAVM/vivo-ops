export type PlayMemberPresentation = {
  label: string;
  dot: string;
  chip: string;
  row: string;
};

// One palette and precedence for advisor execution and administrator supervision.
export function workflowPresentation(
  status: string,
  due: boolean,
  benefitStatus: string,
  contactedAt: string | null,
  respondedAt: string | null,
  playLaunchedAt: string | null,
): PlayMemberPresentation {
  if (benefitStatus === 'redeemed') {
    return {
      label: 'Obsequio entregado',
      dot: 'bg-[#35E293]',
      chip: 'border-[#176344] bg-[#0A2B1D] text-[#68F0B1]',
      row: 'border-l-[#24C77A]',
    };
  }

  if (benefitStatus === 'reserved') {
    return {
      label: 'Obsequio reservado',
      dot: 'bg-[#F0D000]',
      chip: 'border-[#66551A] bg-[#231E0C] text-[#F7DA66]',
      row: 'border-l-[#D6B900]',
    };
  }

  if (due) {
    return {
      label: 'Vencido',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    };
  }

  const presentations: Record<string, { label: string; dot: string; chip: string; row: string }> = {
    pending: {
      label: 'Pendiente',
      dot: 'bg-[#7E8799]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#5F6879]',
    },
    contacted: {
      label: 'Contacto iniciado',
      dot: 'bg-[#69B7FF]',
      chip: 'border-[#214C73] bg-[#102338] text-[#8CC9FF]',
      row: 'border-l-[#3C8FD9]',
    },
    follow_up_scheduled: {
      label: 'Seguimiento',
      dot: 'bg-[#F0D000]',
      chip: 'border-[#564511] bg-[#2A2209] text-[#F7DA66]',
      row: 'border-l-[#D6B900]',
    },
    responded: {
      label: 'Respondió saludo',
      dot: 'bg-[#B694FF]',
      chip: 'border-[#4A3675] bg-[#241A3A] text-[#C9B1FF]',
      row: 'border-l-[#8D68E1]',
    },
    launched: {
      label: 'Jugada lanzada',
      dot: 'bg-[#69B7FF]',
      chip: 'border-[#214C73] bg-[#102338] text-[#8CC9FF]',
      row: 'border-l-[#3C8FD9]',
    },
    accepted: {
      label: 'Aceptó',
      dot: 'bg-[#7CE0A9]',
      chip: 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]',
      row: 'border-l-[#41B879]',
    },
    converted: {
      label: 'Recompra',
      dot: 'bg-[#35E293]',
      chip: 'border-[#176344] bg-[#0A2B1D] text-[#68F0B1]',
      row: 'border-l-[#24C77A]',
    },
    not_interested: {
      label: 'No aceptó',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    },
    unreachable: {
      label: 'Sin respuesta',
      dot: 'bg-[#F5A65B]',
      chip: 'border-[#68401B] bg-[#2F1E0D] text-[#F6B97D]',
      row: 'border-l-[#D8893D]',
    },
    not_applicable: {
      label: 'No aplica',
      dot: 'bg-[#8B93A7]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#6D7587]',
    },
    closed: {
      label: 'Cerrado',
      dot: 'bg-[#8B93A7]',
      chip: 'border-[#343A48] bg-[#171B24] text-[#B7BECC]',
      row: 'border-l-[#6D7587]',
    },
    removed: {
      label: 'Retirado',
      dot: 'bg-[#F06B78]',
      chip: 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]',
      row: 'border-l-[#D95360]',
    },
  };

  if (['follow_up_scheduled', 'accepted', 'converted', 'not_interested', 'unreachable', 'not_applicable', 'closed', 'removed'].includes(status)) {
    return presentations[status] ?? presentations.pending;
  }
  if (playLaunchedAt) return presentations.launched;
  if (respondedAt) return presentations.responded;
  if (contactedAt) return presentations.contacted;
  return presentations.pending;
}

export function isPlayFollowUpDue(value: string | null, now: number): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp <= now;
}

