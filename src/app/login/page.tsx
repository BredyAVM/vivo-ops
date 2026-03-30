import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const ctx = await getAuthContext();

  if (ctx) {
    redirect(resolveHomePath(ctx.roles));
  }

  return <LoginForm />;
}
