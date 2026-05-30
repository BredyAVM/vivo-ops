'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

export default function AdvisorCalendarStrip({
  activeDateLabel,
  selectedDayKey,
  todayKey,
}: {
  activeDateLabel: string;
  selectedDayKey: string;
  todayKey: string;
}) {
  const [optimisticDayKey, setOptimisticDayKey] = useState(selectedDayKey);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    setOptimisticDayKey(selectedDayKey);
  }, [selectedDayKey]);

  const dayHref = (dayKey: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('day', dayKey);
    return `${pathname}?${params.toString()}`;
  };

  const handleDateChange = (dayKey: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return;
    setOptimisticDayKey(dayKey);
    router.push(dayHref(dayKey));
  };

  return (
    <section className="rounded-[20px] border border-[#232632] bg-[#12151d] px-3.5 py-3 shadow-[0_14px_28px_rgba(0,0,0,0.12)]">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Agenda</div>
          <div className="mt-1 truncate text-sm font-semibold text-[#F5F7FB]">{activeDateLabel}</div>
        </div>
        <label className="ml-auto min-w-0 flex-1 sm:max-w-[220px]">
          <span className="sr-only">Seleccionar fecha</span>
          <input
            type="date"
            value={optimisticDayKey}
            onChange={(event) => handleDateChange(event.target.value)}
            className="h-10 w-full rounded-[14px] border border-[#232632] bg-[#0F131B] px-3 text-sm font-semibold text-[#F5F7FB] outline-none [color-scheme:dark]"
          />
        </label>
        <Link
          href={dayHref(todayKey)}
          onClick={() => setOptimisticDayKey(todayKey)}
          className={[
            'inline-flex h-10 shrink-0 items-center rounded-[14px] border px-3 text-xs font-semibold transition active:scale-[0.98]',
            optimisticDayKey === todayKey
              ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
              : 'border-[#232632] text-[#CCD3E2]',
          ].join(' ')}
        >
          Hoy
        </Link>
      </div>
    </section>
  );
}
