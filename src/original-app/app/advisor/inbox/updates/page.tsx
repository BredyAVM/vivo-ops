import AdvisorInboxPage from '../page';

export default function AdvisorInboxUpdatesPage() {
  return <AdvisorInboxPage searchParams={Promise.resolve({ filter: 'updates' })} />;
}
