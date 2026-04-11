import { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { getAuthContext } from '@/lib/auth';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0b0b0d', color: 'white', fontFamily: 'system-ui' }}>
      {children}
    </div>
  );
}
