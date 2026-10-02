'use client';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { adminWorkspaceHref } from '@/lib/navigation/admin-workspace';
export function useWorkspaceRouter() {
  const router = useRouter();
  const pathname = usePathname();
  return useMemo(() => ({
    ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(adminWorkspaceHref(href, pathname), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(adminWorkspaceHref(href, pathname), options),
  }), [router, pathname]);
}
