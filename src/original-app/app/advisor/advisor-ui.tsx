import Link from 'next/link';
import type { ReactNode } from 'react';

export function PageIntro({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-3.5 shadow-[0_14px_28px_rgba(0,0,0,0.16)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-[#8B93A7]">{eyebrow}</p>
          <h2 className="mt-1 text-[20px] font-semibold tracking-[-0.03em] text-[#F5F7FB]">{title}</h2>
          <p className="mt-1.5 text-[13px] leading-5 text-[#AAB2C5]">{description}</p>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
    </section>
  );
}

export function QuickLink({
  href,
  title,
  detail,
  tone = 'neutral',
}: {
  href: string;
  title: string;
  detail: string;
  tone?: 'neutral' | 'primary';
}) {
  return (
    <Link
      href={href}
      className={[
        'rounded-[22px] border px-4 py-4 transition active:scale-[0.99]',
        tone === 'primary'
          ? 'border-[#F0D000] bg-[#F0D000] text-[#151719]'
          : 'border-[#232632] bg-[#12151d] text-[#F5F7FB]',
      ].join(' ')}
    >
      <div className="text-[15px] font-semibold">{title}</div>
      <div className={['mt-1 text-xs leading-5', tone === 'primary' ? 'text-[#3F3B14]' : 'text-[#8B93A7]'].join(' ')}>
        {detail}
      </div>
    </Link>
  );
}

export function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <article className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8B93A7]">{label}</p>
      <div className="mt-2 text-[28px] font-semibold tracking-[-0.04em] text-[#F5F7FB]">{value}</div>
      <p className="mt-1 text-xs leading-5 text-[#AAB2C5]">{detail}</p>
    </article>
  );
}

export function SectionCard({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-[22px] border border-[#232632] bg-[#12151d] px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[#F5F7FB]">{title}</h3>
          {subtitle ? <p className="mt-1 text-xs leading-5 text-[#8B93A7]">{subtitle}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

export function StatusBadge({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'warning' | 'success' | 'danger';
}) {
  const colorClass =
    tone === 'warning'
      ? 'border-[#564511] bg-[#2A2209] text-[#F7DA66]'
      : tone === 'success'
        ? 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]'
        : tone === 'danger'
          ? 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]'
          : 'border-[#2A3040] bg-[#151925] text-[#CCD3E2]';

  return <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${colorClass}`}>{label}</span>;
}

export function EmptyBlock({
  title,
  detail,
  href,
  cta,
}: {
  title: string;
  detail: string;
  href?: string;
  cta?: string;
}) {
  return (
    <div className="rounded-[18px] border border-dashed border-[#2A3040] bg-[#0F131B] px-4 py-4 text-sm text-[#AAB2C5]">
      <div className="font-medium text-[#F5F7FB]">{title}</div>
      <div className="mt-1 leading-5">{detail}</div>
      {href && cta ? (
        <Link href={href} className="mt-3 inline-flex h-9 items-center rounded-xl border border-[#2A3040] px-3 text-sm font-medium text-[#F5F7FB]">
          {cta}
        </Link>
      ) : null}
    </div>
  );
}
