export default function AdvisorClientsLoading() {
  return (
    <div className="space-y-4" aria-label="Cargando cartera">
      <div className="h-28 animate-pulse rounded-[24px] border border-[#232632] bg-[#12151D]" />
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <div key={index} className="h-28 animate-pulse rounded-[18px] border border-[#232632] bg-[#12151D]" />
        ))}
      </div>
      <div className="h-48 animate-pulse rounded-[22px] border border-[#232632] bg-[#12151D]" />
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="h-72 animate-pulse rounded-[20px] border border-[#232632] bg-[#12151D]" />
      ))}
    </div>
  );
}
