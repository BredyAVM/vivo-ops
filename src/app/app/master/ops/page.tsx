import { OrdersWorkspace, type OrdersWorkspaceSearchParams } from "@/lib/orders/operations-workspace";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function MasterOpsPage({ searchParams }: { searchParams?: OrdersWorkspaceSearchParams }) {
  return <OrdersWorkspace surface="master" searchParams={searchParams} />;
}
