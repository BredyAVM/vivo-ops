import Link from 'next/link';

export default function AdvisorInboxBell({
  advisorName,
  unreadCount,
  href = '/app/advisor/inbox?filter=all',
}: {
  advisorName: string;
  unreadCount: number;
  href?: string;
}) {
  return (
    <Link
      href={href}
      className="relative inline-flex h-11 w-11 items-center justify-center rounded-[16px] border border-[#232632] bg-[#0F131B] text-[#F5F7FB]"
      aria-label={`Notificaciones de ${advisorName}`}
    >
      <span className="text-lg">!</span>
      {unreadCount > 0 ? (
        <span className="absolute -right-1 -top-1 inline-flex min-w-[20px] justify-center rounded-full bg-[#F0D000] px-1.5 py-0.5 text-[11px] font-semibold text-[#17191E]">
          {unreadCount}
        </span>
      ) : null}
    </Link>
  );
}
