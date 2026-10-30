'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { safeAppReturnHref } from '@/lib/navigation/return-navigation';

export default function BackLink({ fallbackHref, children = '← Volver', className = 'inline-flex min-h-8 items-center text-xs text-[#9696A4] hover:text-[#FEEF00]' }: {
  fallbackHref?: string; children?: ReactNode; className?: string;
}) {
  const search = useSearchParams();
  const href = safeAppReturnHref(search.get('returnTo')) ?? safeAppReturnHref(fallbackHref);
  return href ? <Link href={href} prefetch={false} className={className}>{children}</Link> : null;
}

export function ReturnContextField() {
  const href = safeAppReturnHref(useSearchParams().get('returnTo'));
  return href ? <input type="hidden" name="returnTo" value={href} /> : null;
}
