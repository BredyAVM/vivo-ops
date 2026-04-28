import AdvisorOrderComposer from './AdvisorOrderComposer';

type SearchParams = Promise<{
  fromOrder?: string;
  duplicateFrom?: string;
}>;

export default async function AdvisorNewOrderPage({
  searchParams,
}: {
  searchParams?: SearchParams;
}) {
  const params = (await searchParams) ?? {};
  const fromOrder = Number(params.fromOrder || 0);
  const duplicateFrom = Number(params.duplicateFrom || 0);

  return (
    <AdvisorOrderComposer
      existingOrderId={Number.isFinite(fromOrder) && fromOrder > 0 ? fromOrder : null}
      templateOrderId={Number.isFinite(duplicateFrom) && duplicateFrom > 0 ? duplicateFrom : null}
    />
  );
}
