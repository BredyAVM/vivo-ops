import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';

export default async function AppRoot() {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  redirect(resolveHomePath(ctx.roles));
}
