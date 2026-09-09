'use client';

import Link from 'next/link';

export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="mx-auto max-w-2xl rounded-[28px] border border-red-400/20 bg-[#111117] p-6 sm:p-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-red-300">Administración</p>
      <h1 className="mt-3 text-2xl font-semibold text-white">No pudimos cargar esta vista.</h1>
      <p className="mt-3 text-sm leading-6 text-[#B7B7C2]">
        Revisa el estado de cualquier acción que hayas enviado antes de repetirla. Luego puedes intentarlo de nuevo o
        volver al panel administrativo actual.
      </p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={reset}
          className="min-h-12 rounded-xl bg-[#FEEF00] px-5 text-sm font-bold text-[#0B0B0D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          Intentar de nuevo
        </button>
        <Link
          href="/app/master/dashboard"
          prefetch={false}
          className="flex min-h-12 items-center justify-center rounded-xl border border-[#343443] bg-[#17171F] px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
        >
          Abrir panel actual
        </Link>
      </div>
    </section>
  );
}
