'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

function formatDayLabel(dayKey: string) {
  const date = new Date(`${dayKey}T12:00:00-04:00`);
  if (Number.isNaN(date.getTime())) return 'Seleccionar fecha';

  return date.toLocaleDateString('es-VE', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AdvisorCalendarStrip({
  selectedDayKey,
  todayKey,
}: {
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
    <section className="rounded-[18px] border border-[#232632] bg-[#12151d] px-3 py-2.5 shadow-[0_12px_24px_rgba(0,0,0,0.12)]">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-[#8B93A7]">Agenda del dia</div>
      <div className="grid grid-cols-[minmax(0,1fr)_52px] items-center gap-2">
        <label className="relative block h-10 min-w-0 overflow-hidden rounded-[14px] border border-[#232632] bg-[#0F131B]">
          <span className="sr-only">Seleccionar fecha</span>
          <span aria-hidden="true" className="pointer-events-none flex h-full min-w-0 items-center px-3 pr-8 text-[13px] font-semibold text-[#F5F7FB]">
            <span className="block min-w-0 truncate">{formatDayLabel(optimisticDayKey)}</span>
          </span>
          <input
            type="date"
            value={optimisticDayKey}
            onChange={(event) => handleDateChange(event.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0 [color-scheme:dark]"
          />
        </label>
        <Link
          href={dayHref(todayKey)}
          onClick={() => setOptimisticDayKey(todayKey)}
          className={[
            'inline-flex h-10 w-[52px] shrink-0 items-center justify-center rounded-[14px] border text-xs font-semibold transition active:scale-[0.98]',
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
