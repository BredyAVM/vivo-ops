'use client';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useMemo } from 'react';
import { appContextHref } from '@/lib/navigation/return-navigation';
import { adminWorkspaceHref } from '@/lib/navigation/admin-workspace';
export function useWorkspaceRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const search=useSearchParams().toString();
  const current=pathname+(search?'?'+search:'');
  return useMemo(() => ({
    ...router,
    push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(appContextHref(adminWorkspaceHref(href, current),current), options),
    replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(appContextHref(adminWorkspaceHref(href, current),current), options),
  }), [router, current]);
}
