import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import AdvisorShell from './AdvisorShell';
import { getAuthContext, isMasterOrAdminRole, resolveHomePath } from '@/lib/auth';

export default async function AdvisorLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  const canAccessAdvisor = isMasterOrAdminRole(ctx.roles) || ctx.roles.includes('advisor');
  if (!canAccessAdvisor) {
    redirect(resolveHomePath(ctx.roles));
  }

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  return (
    <AdvisorShell
      email={ctx.user.email ?? 'sin-correo'}
      fullName={profile?.full_name?.trim() || ctx.user.user_metadata?.full_name || ctx.user.email || 'Asesor'}
    >
      {children}
    </AdvisorShell>
  );
}
