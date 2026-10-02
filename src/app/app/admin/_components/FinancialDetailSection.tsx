'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Expand the requested breakdown, including a second click on the same hash. */
export default function FinancialDetailSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const open = () => { if (location.hash === '#' + id && ref.current) ref.current.open = true; };
    const followLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      const destination = new URL(link.getAttribute('href')!, location.href);
      if (destination.origin === location.origin && destination.pathname === location.pathname && destination.hash === '#' + id && ref.current) ref.current.open = true;
    };
    open();
    window.addEventListener('hashchange', open);
    document.addEventListener('click', followLink);
    return () => { window.removeEventListener('hashchange', open); document.removeEventListener('click', followLink); };
  }, [id]);
  return <details ref={ref} id={id} className="scroll-mt-24 rounded-xl border border-[#2A2A38] bg-[#111117] p-3">
    <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-[#E4E4EA] focus-visible:outline-2 focus-visible:outline-[#FFFF00] md:min-h-8">{title}</summary>
    <div className="mt-2">{children}</div>
  </details>;
}
