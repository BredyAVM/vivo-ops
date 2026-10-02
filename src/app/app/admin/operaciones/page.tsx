import AdminSectionHub from '../_components/AdminSectionHub';

// Admin authorization is enforced by the shared layout. No business queries here.
export default function AdminOperationsPage() {
  return <AdminSectionHub section="operations" />;
}
