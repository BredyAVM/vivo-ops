import Link from 'next/link';
import { requireAuthContext } from '@/lib/auth';
import type { EventWorkspace } from '@/lib/events/event-workspace';
import EventWorkspaceClient from './EventWorkspaceClient';

export const dynamic = 'force-dynamic';
export default async function EventWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAuthContext();
  const { id } = await params;
  if (!/^\d+$/.test(id)) return <p>Evento no válido.</p>;
  const { data, error } = await ctx.supabase.rpc('event_workspace_read_v1', { p_root_id: Number(id) });
  if (error) return <main className="p-6"><Link href="/app/events/ongoing">Volver a eventos</Link><p role="alert">No se pudo abrir el evento: {error.message}</p></main>;
  return <EventWorkspaceClient data={data as EventWorkspace} admin={ctx.roles.includes('admin')} master={ctx.roles.includes('master') || ctx.roles.includes('admin')} />;
}
