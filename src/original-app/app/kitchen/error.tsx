'use client';

export default function KitchenError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="kitchen-app flex min-h-screen items-center justify-center bg-[#08090D] px-5 text-[#F5F5F7]">
      <section className="w-full max-w-sm rounded-2xl border border-red-400/35 bg-red-400/10 p-5 text-center">
        <div className="text-xs font-bold uppercase tracking-[0.16em] text-red-200">Cocina</div>
        <h1 className="mt-2 text-xl font-black">No pudimos cargar los pedidos</h1>
        <p className="mt-2 text-sm text-red-100/80">
          Revisa la conexión y vuelve a intentarlo. Ninguna acción se realizó.
        </p>
        <button
          type="button"
          onClick={reset}
          className="mt-4 h-12 w-full rounded-xl border border-[#FEEF00]/60 bg-[#FEEF00] px-4 font-black text-black"
        >
          Reintentar
        </button>
      </section>
    </main>
  );
}
