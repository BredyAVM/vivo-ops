import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminWorkspaceHref } from './admin-workspace';

// This header is overwritten by the proxy; it conveys routing, never permissions.
export async function redirectInWorkspace(href: string): Promise<never> {
  const current = (await headers()).get('x-vivo-workspace-path') ?? '';
  redirect(adminWorkspaceHref(href, current));
}
