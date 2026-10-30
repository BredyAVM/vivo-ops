export default function KitchenLoading() {
  return (
    <main className="kitchen-app min-h-screen bg-[#08090D] text-[#F5F5F7]">
      <div className="mx-auto w-full max-w-[640px] px-3 pb-6">
        <div className="kitchen-safe-header h-32 animate-pulse border-b border-[#242433]">
          <div className="mt-3 h-3 w-20 rounded bg-[#242433]" />
          <div className="mt-3 h-7 w-32 rounded bg-[#242433]" />
          <div className="mt-5 grid grid-cols-3 gap-2">
            <div className="h-12 rounded-xl bg-[#16161F]" />
            <div className="h-12 rounded-xl bg-[#16161F]" />
            <div className="h-12 rounded-xl bg-[#16161F]" />
          </div>
        </div>
        <div className="mt-4 space-y-3" aria-label="Cargando pedidos de cocina">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-40 animate-pulse rounded-xl border border-[#242433] bg-[#101018]" />
          ))}
        </div>
      </div>
    </main>
  );
}
