import Link from '@/components/navigation/ContextLink';
import { desktopAdminNavigationGroups, type AdminNavigationItem } from '../_lib/navigation';

type HubAction = Pick<AdminNavigationItem, 'label' | 'description' | 'href'>;

export default function AdminSectionHub({ section, actions = [] }: {
  section: 'operations' | 'finance' | 'business';
  actions?: readonly HubAction[];
}) {
  const group = desktopAdminNavigationGroups.find((candidate) => candidate.key === section)!;
  const destinations = group.items.filter((item) => item.key !== section);
  return (
    <div className="space-y-4">
      <header><h1 className="text-lg font-semibold tracking-tight text-[#E6E6ED]">{group.label}</h1><p className="mt-1 text-xs text-[#9B9BA7]">Selecciona qué necesitas consultar u operar.</p></header>
      {actions.length > 0 ? <nav aria-label="Acciones financieras" className="flex flex-wrap gap-2">
        {actions.map((action) => <Link key={action.href} href={action.href} prefetch={false} title={action.description} className="inline-flex min-h-11 items-center rounded-lg border border-[#FFFF00]/25 bg-[#FFFF00]/5 px-3 text-xs font-medium text-[#FFFF00] hover:bg-[#FFFF00]/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]">{action.label}</Link>)}
      </nav> : null}
      <nav aria-label={`Centros de ${group.label.toLowerCase()}`} className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {destinations.map((item) => <Link key={item.key} href={item.href} prefetch={false} className="group flex min-h-20 min-w-0 items-center justify-between gap-3 rounded-xl border border-[#292937] bg-[#111117] p-3 hover:border-[#FFFF00]/35 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]">
          <span className="min-w-0"><span className="block text-sm font-medium text-[#DEDEE6] group-hover:text-[#FFFF00]">{item.label}</span><span className="mt-1 block text-xs leading-5 text-[#9B9BA7]">{item.description}</span>{!item.href.startsWith('/app/admin') ? <span className="mt-1 block text-[10px] text-[#9B9BA7]">Vista compartida · integración pendiente</span> : null}</span>
          <span aria-hidden="true" className="shrink-0 text-[#888895] group-hover:text-[#FFFF00]">→</span>
        </Link>)}
      </nav>
    </div>
  );
}
