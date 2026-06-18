import { redirect } from 'next/navigation';
import { getAvailableModulesForRoles, getEnabledModulesForRoles, resolveHomePathForRoles } from '@/lib/app-modules';
import { getAuthContext } from '@/lib/auth';
import ModuleSelectorClient from './ModuleSelectorClient';

export default async function AppRoot() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const modules = getAvailableModulesForRoles(ctx.roles);
  const enabledModules = getEnabledModulesForRoles(ctx.roles);

  if (modules.length <= 1 && enabledModules.length === 1) {
    redirect(resolveHomePathForRoles(ctx.roles));
  }

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  return (
    <ModuleSelectorClient
      modules={modules}
      fullName={
        profile?.full_name?.trim() ||
        ctx.user.user_metadata?.full_name ||
        ctx.user.user_metadata?.name ||
        ''
      }
      email={ctx.user.email || ''}
    />
  );
}
