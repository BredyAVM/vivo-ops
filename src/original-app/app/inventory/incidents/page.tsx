import { redirectInWorkspace } from '@/lib/navigation/workspace-server';

export default async function InventoryIncidentsPage() {
  await redirectInWorkspace('/app/inventory/alerts');
}
