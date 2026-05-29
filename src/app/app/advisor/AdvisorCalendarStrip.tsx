'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

type CalendarDay = {
  key: string;
  label: string;
  dayNumber: string;
  monthLabel: string;
  isToday: boolean;
};

export default function AdvisorCalendarStrip({
  activeDateLabel,
  calendarDays,
  searchQuery,
  selectedDayKey,
  todayKey,
}: {
  activeDateLabel: string;
  calendarDays: CalendarDay[];
  searchQuery: string;
  selectedDayKey: string;
  todayKey: string;
}) {
  const [optimisticDayKey, setOptimisticDayKey] = useState(selectedDayKey);

  useEffect(() => {
    setOptimisticDayKey(selectedDayKey);
  }, [selectedDayKey]);

  const dayHref = (dayKey: string) =>
    `/app/advisor?day=${dayKey}${searchQuery ? `&q=${encodeURIComponent(searchQuery)}` : ''}`;

  return (
    <section className="rounded-[20px] border border-[#232632] bg-[#12151d] px-3.5 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Agenda</div>
          <div className="mt-1 truncate text-sm font-semibold text-[#F5F7FB]">{activeDateLabel}</div>
        </div>
        <Link
          href={dayHref(todayKey)}
          onClick={() => setOptimisticDayKey(todayKey)}
          onPointerDown={() => setOptimisticDayKey(todayKey)}
          className={[
            'shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold transition active:scale-[0.98]',
            optimisticDayKey === todayKey
              ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
              : 'border-[#232632] text-[#CCD3E2]',
          ].join(' ')}
        >
          Hoy
        </Link>
      </div>

      <div className="-mx-3.5 mt-2.5 overflow-x-auto overscroll-x-contain scroll-smooth px-3.5 pb-1 [scrollbar-width:thin]">
        <div className="flex min-w-max snap-x snap-mandatory gap-2">
          {calendarDays.map((day) => {
            const isActive = day.key === optimisticDayKey;

            return (
              <Link
                key={day.key}
                href={dayHref(day.key)}
                onClick={() => setOptimisticDayKey(day.key)}
                onPointerDown={() => setOptimisticDayKey(day.key)}
                className={[
                  'min-w-[68px] snap-start rounded-[16px] border px-2.5 py-2.5 text-center transition active:scale-[0.98]',
                  isActive
                    ? 'border-[#F0D000] bg-[#201B08] text-[#F7DA66]'
                    : 'border-[#232632] bg-[#12151d] text-[#CCD3E2]',
                ].join(' ')}
              >
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em]">{day.label}</div>
                <div className="mt-1 text-lg font-semibold">{day.dayNumber}</div>
                <div className="mt-0.5 text-[10px] text-[#8B93A7]">{day.isToday ? 'Hoy' : day.monthLabel}</div>
              </Link>
            );
          })}
        </div>
      </div>
    </section>
  );
}
