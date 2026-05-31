'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { type MouseEvent, type ReactNode, useEffect, useState } from 'react';

type AdvisorPendingLinkProps = {
  href: string;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  title?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export default function AdvisorPendingLink({
  href,
  children,
  className,
  ariaLabel,
  title,
  onClick,
}: AdvisorPendingLinkProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const currentSearch = searchParams.toString();
  const currentHref = `${pathname}${currentSearch ? `?${currentSearch}` : ''}`;
  const isBusy = pendingHref === href;

  useEffect(() => {
    setPendingHref(null);
  }, [pathname, currentSearch]);

  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      aria-busy={isBusy}
      data-busy={isBusy ? 'true' : undefined}
      title={title}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          href === currentHref
        ) {
          return;
        }
        setPendingHref(href);
      }}
      className={className}
    >
      {children}
    </Link>
  );
}
