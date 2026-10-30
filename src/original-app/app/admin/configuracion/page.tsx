import Link from '@/components/navigation/ContextLink';
import { requireAdminContext } from '@/lib/auth';
export default async function ConfigurationHub() {
  await requireAdminContext();
  return <div className="space-y-3"><h1 className="text-lg font-semibold">Configuración</h1><nav className="grid gap-2 sm:grid-cols-2">{[['Cuentas y permisos','cuentas'],['Tasa general e historial','tasa'],['Empresas y tarifas de delivery','delivery'],['Usuarios y roles','usuarios'],['Clientes','clientes']].map(([label,key])=><Link key={key} href={'/app/admin/configuracion/'+key} prefetch={false} className="flex min-h-16 items-center justify-between rounded-xl border border-[#292937] bg-[#111117] p-3 text-xs"><span>{label}</span><span className="text-[#FFFF00]">→</span></Link>)}</nav></div>;
}
