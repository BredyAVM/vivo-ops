import { redirect } from 'next/navigation';
import { createSupabaseServer } from '@/lib/supabase/server';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const supabase = await createSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
   redirect('/app/master/dashboard');
  }

  return <LoginForm />;
}