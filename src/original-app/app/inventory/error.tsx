'use client';

export default function InventoryError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
      <h2 className="text-lg font-semibold text-red-300">No se pudo cargar el inventario</h2>
      <p className="mt-2 text-sm text-[#B7B7C2]">
        La información no fue modificada. Puedes intentar la consulta nuevamente.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded-xl border border-red-400/40 px-3 py-2 text-sm font-semibold text-red-200"
      >
        Reintentar
      </button>
    </div>
  );
}
