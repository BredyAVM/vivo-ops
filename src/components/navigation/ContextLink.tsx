'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import type { ComponentProps } from 'react';
import { appContextHref } from '@/lib/navigation/return-navigation';

export default function ContextLink({ href, ...props }: ComponentProps<typeof Link>) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const current = search ? `${pathname}?${search}` : pathname;
  return <Link {...props} href={typeof href === 'string' ? appContextHref(href, current) : href} />;
}
