// Local-only UI fixture. No credentials, database calls or real notifications.
import { redirect } from 'next/navigation';
import WorkspaceForm from '../../../../../src/components/navigation/WorkspaceForm';
import GoalConfigurationActions from '../../../../../src/app/app/commissions/goals/GoalConfigurationActions';

async function simulate(formData: FormData) {
  'use server';
  // Deliberate latency lets the browser verify loading and repeated-click prevention.
  await new Promise((resolve) => setTimeout(resolve, 12000));
  const error = formData.get('outcome') === 'error';
  const notice = formData.get('intent') === 'publish'
    ? 'Metas publicadas con trazabilidad por asesor.' : 'Simulación guardada como borrador.';
  redirect(`/?feedback=${Date.now()}&${error ? 'error=Debes%20indicar%20el%20motivo.'
    : `published=${formData.get('intent') === 'publish' ? '1' : '0'}&notice=${encodeURIComponent(notice)}`}`);
}

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  return <main className="mx-auto max-w-3xl space-y-5 px-5 py-8">
    <p className="text-xs text-sky-200">VERIFICACIÓN LOCAL · SIN DATOS REALES · NO PUBLICA METAS</p>
    <h1 className="text-2xl font-semibold">Metas y porcentajes · prueba de respuesta</h1>
    <p className="text-sm text-[#A9A9B4]">Noviembre 01 · acción simulada de 12 segundos.</p>
    <WorkspaceForm action={simulate} className="grid gap-4 rounded-3xl border border-[#292933] bg-[#121217] p-5 md:grid-cols-2">
      <h2 className="text-lg font-semibold md:col-span-2">Guardar o publicar esta versión</h2>
      <label className="text-sm">Resultado simulado
        <select name="outcome" className="mt-2 block h-10 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3">
          <option value="success">Éxito</option><option value="error">Error</option>
        </select>
      </label>
      <label className="text-sm">Motivo
        <input name="reason" className="mt-2 block h-10 w-full rounded-xl border border-[#33333E] bg-[#0E0E12] px-3" />
      </label>
      <GoalConfigurationActions publishedAt={params.published === '1' ? '2026-11-09T13:36:49.924Z' : null}
        feedbackKey={params.feedback} notice={params.notice} error={params.error} periodName="Noviembre 01 · prueba" />
    </WorkspaceForm>
    <div className="h-[1200px] rounded-3xl border border-[#292933] p-5 text-sm text-[#A9A9B4]">Espacio de prueba para comprobar el aviso aunque la página esté desplazada.</div>
  </main>;
}
