'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function AdvisorSearchForm({
  selectedDayKey,
  searchQuery,
}: {
  selectedDayKey: string;
  searchQuery: string;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setBusy(false);
  }, [pathname, searchParams]);

  return (
    <form action="/app/advisor" className="flex gap-2" onSubmit={() => setBusy(true)}>
      <input type="hidden" name="day" value={selectedDayKey} />
      <input
        name="q"
        defaultValue={searchQuery}
        placeholder="Cliente, telefono u orden"
        className="h-11 min-w-0 flex-1 rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 text-sm text-[#F5F7FB] outline-none placeholder:text-[#636C80]"
      />
      <button
        type="submit"
        aria-busy={busy}
        data-busy={busy ? 'true' : undefined}
        disabled={busy}
        className="h-11 min-w-[86px] rounded-[16px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E] disabled:cursor-wait"
      >
        {busy ? 'Buscando...' : 'Buscar'}
      </button>
    </form>
  );
}
