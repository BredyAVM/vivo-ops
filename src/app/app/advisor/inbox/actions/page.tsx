import AdvisorInboxPage from '../page';

export default function AdvisorInboxActionsPage() {
  return <AdvisorInboxPage searchParams={Promise.resolve({ filter: 'pending' })} />;
}
