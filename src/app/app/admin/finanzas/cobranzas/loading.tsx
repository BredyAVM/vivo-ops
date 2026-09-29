export default function LoadingCollections() {
  return <div role="status" className="space-y-3" aria-label="Consultando saldos actuales"><div className="h-10 animate-pulse rounded-xl bg-zinc-800" /><div className="h-24 animate-pulse rounded-xl bg-zinc-800" /><div className="h-80 animate-pulse rounded-xl bg-zinc-800" /><span className="sr-only">Consultando cobranzas…</span></div>;
}
