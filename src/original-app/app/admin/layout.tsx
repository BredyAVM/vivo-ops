import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthContext, isAdminRole, resolveHomePath } from '@/lib/auth';
import AdminShell from './_components/AdminShell';
import AdminPwaRegistrar from './AdminPwaRegistrar';
import { PwaInstallProvider } from '@/components/notifications/PwaInstallProvider';

export const metadata: Metadata = {
  title: 'VIVO OPS Administración',
  description: 'Centro administrativo de VIVO OPS',
  manifest: '/pwa/admin.webmanifest',
  appleWebApp: { capable: true, title: 'VIVO Admin', statusBarStyle: 'black-translucent' },
  icons: { apple: '/pwa/admin-180.png' },
};

export const viewport: Viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#0B0B0D',
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

  return <PwaInstallProvider>
    <AdminPwaRegistrar userId={ctx.user.id} />
    <AdminShell userLabel={userLabel} email={ctx.user.email || ''}>{children}</AdminShell>
  </PwaInstallProvider>;
}
