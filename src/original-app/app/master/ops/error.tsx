"use client";

export default function MasterOpsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="grid min-h-screen place-items-center bg-[#0B0B0D] px-4 text-[#F5F5F7]">
      <div className="w-full max-w-md rounded-2xl border border-red-500/30 bg-[#121218] p-6 text-center shadow-2xl">
        <div className="text-lg font-semibold">No se pudo cargar Master Ops</div>
        <div className="mt-2 text-sm text-[#B7B7C2]">
          La operación no fue modificada. Vuelve a consultar los datos del servidor.
        </div>
        {error.message ? (
          <div className="mt-4 rounded-xl border border-[#30242A] bg-[#0B0B0D] px-3 py-2 text-xs text-red-200">
            {error.message}
          </div>
        ) : null}
        <button
          className="mt-5 rounded-xl border border-[#FEEF00] bg-[#FEEF00] px-4 py-2 text-sm font-semibold text-[#0B0B0D]"
          type="button"
          onClick={reset}
        >
          Reintentar
        </button>
      </div>
    </div>
  );
}
