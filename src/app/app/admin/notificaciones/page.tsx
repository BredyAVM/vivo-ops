import {requireAdminContext} from '@/lib/auth';
import OperationsPushPanel from '@/components/notifications/OperationsPushPanel';
import {getPublicVapidKey} from '@/lib/push';
import {InstallApplicationPanel} from '@/components/notifications/PwaInstallProvider';
export default async function NotificationsPage(){
 await requireAdminContext();
 return <div className="max-w-2xl space-y-3"><h1 className="text-lg font-semibold text-[#DEDEE6]">App y notificaciones</h1><InstallApplicationPanel/><OperationsPushPanel publicVapidKey={getPublicVapidKey()} workspace="admin" targetUrl="/app/admin/operaciones"/></div>;
}
