import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthContext, isAdminRole, resolveHomePath } from '@/lib/auth';
import AdminShell from './_components/AdminShell';

export const metadata: Metadata = {
  title: 'VIVO OPS Administración',
  description: 'Centro administrativo de VIVO OPS',
  manifest: null,
  appleWebApp: null,
  icons: null,
};

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  if (!isAdminRole(ctx.roles)) {
    redirect(resolveHomePath(ctx.roles));
  }

  const userLabel =
    String(ctx.user.user_metadata?.full_name || '').trim() ||
    String(ctx.user.user_metadata?.name || '').trim() ||
    'Administrador';

  return <AdminShell userLabel={userLabel} email={ctx.user.email || ''}>{children}</AdminShell>;
}
