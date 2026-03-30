import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole } from '@/lib/auth';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  if (!isMasterOrAdminRole(ctx.roles)) {
    redirect('/orders');
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f0f0f', color: 'white', fontFamily: 'system-ui' }}>
      {children}
    </div>
  );
}
