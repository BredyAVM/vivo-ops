import { getAuthContext } from '@/lib/auth';
import { PageIntro } from '../advisor-ui';
import AdvisorPushPanel from '../inbox/AdvisorPushPanel';
import AdvisorSettingsClient from './AdvisorSettingsClient';
import { getPublicVapidKey } from '@/lib/push';

export default async function AdvisorSettingsPage() {
  const ctx = await getAuthContext();
  if (!ctx) return null;

  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('full_name')
    .eq('id', ctx.user.id)
    .maybeSingle();

  const fullName =
    profile?.full_name?.trim() ||
    String(ctx.user.user_metadata?.full_name || ctx.user.user_metadata?.name || 'Asesor').trim() ||
    'Asesor';
  const email = String(ctx.user.email || '').trim() || 'Sin correo';

  return (
    <div className="space-y-4">
      <PageIntro
        eyebrow="Sistema"
        title="Configuracion"
        description="Aqui viven los permisos, la sesion y las revisiones utiles para que la app siga operativa."
      />

      <AdvisorPushPanel publicVapidKey={getPublicVapidKey()} />

      <AdvisorSettingsClient fullName={fullName} email={email} />
    </div>
  );
}
