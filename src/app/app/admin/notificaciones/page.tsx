import {requireAdminContext} from '@/lib/auth';
import OperationsPushPanel from '@/components/notifications/OperationsPushPanel';
import {getPublicVapidKey} from '@/lib/push';
export default async function NotificationsPage(){
 await requireAdminContext();
 return <div className="max-w-2xl space-y-3"><h1 className="text-lg font-semibold text-[#DEDEE6]">Notificaciones</h1><OperationsPushPanel publicVapidKey={getPublicVapidKey()} targetUrl="/app/admin/operaciones"/></div>;
}
