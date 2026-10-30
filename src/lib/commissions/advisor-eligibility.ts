import type { SupabaseClient } from '@supabase/supabase-js';

export type AdvisorRoleProfile = {
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
};

export type AdvisorCommissionProfile = {
  id: string;
  full_name: string | null;
  is_active: boolean | null;
  receives_commissions: boolean | null;
};

export type EligibleCommissionAdvisor = {
  userId: string;
  fullName: string;
};

export function selectEligibleCommissionAdvisors(input: {
  advisorProfiles: AdvisorRoleProfile[];
  commissionProfiles: AdvisorCommissionProfile[];
  advisorUserId?: string | null;
}) {
  const requestedAdvisorId = String(input.advisorUserId || '').trim();
  const commissionProfileById = new Map(
    input.commissionProfiles.map((profile) => [String(profile.id), profile])
  );

  return input.advisorProfiles
    .filter((advisor) => Boolean(advisor.is_active ?? true))
    .filter((advisor) => !requestedAdvisorId || String(advisor.user_id) === requestedAdvisorId)
    .filter((advisor) => {
      const profile = commissionProfileById.get(String(advisor.user_id));
      return Boolean(profile?.is_active ?? false) && profile?.receives_commissions === true;
    })
    .map((advisor) => ({
      userId: String(advisor.user_id),
      fullName: advisor.full_name?.trim() || 'Asesor',
    }))
    .sort((left, right) => left.fullName.localeCompare(right.fullName, 'es'));
}

export async function loadEligibleCommissionAdvisors(
  supabase: SupabaseClient,
  advisorUserId?: string | null
): Promise<EligibleCommissionAdvisor[]> {
  const { data: advisorData, error: advisorError } = await supabase.rpc('get_advisor_profiles');
  if (advisorError) throw new Error(advisorError.message);

  const advisorProfiles = (advisorData ?? []) as AdvisorRoleProfile[];
  const advisorIds = Array.from(
    new Set(
      advisorProfiles
        .map((advisor) => String(advisor.user_id || '').trim())
        .filter(Boolean)
    )
  );

  if (advisorIds.length === 0) return [];

  const { data: commissionData, error: commissionError } = await supabase
    .from('profiles')
    .select('id, full_name, is_active, receives_commissions')
    .in('id', advisorIds);

  if (commissionError) throw new Error(commissionError.message);

  return selectEligibleCommissionAdvisors({
    advisorProfiles,
    commissionProfiles: (commissionData ?? []) as AdvisorCommissionProfile[],
    advisorUserId,
  });
}

export async function advisorReceivesCommissions(
  supabase: SupabaseClient,
  advisorUserId: string
) {
  const userId = String(advisorUserId || '').trim();
  if (!userId) return false;

  const { data, error } = await supabase
    .from('profiles')
    .select('is_active, receives_commissions')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return Boolean(data?.is_active ?? false) && data?.receives_commissions === true;
}
