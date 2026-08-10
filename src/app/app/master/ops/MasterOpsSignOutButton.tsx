"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase/browser";
import { LAST_MODULE_STORAGE_KEY } from "../../ModulePreference";

export default function MasterOpsSignOutButton() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setError(null);

    const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
    if (signOutError) {
      setError("No se pudo cerrar la sesión.");
      setIsSigningOut(false);
      return;
    }

    window.localStorage.removeItem(LAST_MODULE_STORAGE_KEY);
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="shrink-0 text-right">
      <button
        className="rounded-xl border border-red-500/35 bg-red-500/5 px-2 py-2 text-[11px] font-semibold text-red-200 transition hover:border-red-400/70 hover:bg-red-500/10 disabled:cursor-wait disabled:opacity-60"
        type="button"
        disabled={isSigningOut}
        onClick={handleSignOut}
        title="Cerrar la sesión local para cambiar de operador"
      >
        {isSigningOut ? "Cerrando..." : "Cerrar sesión"}
      </button>
      {error ? <div className="mt-1 text-[10px] text-red-300" role="alert">{error}</div> : null}
    </div>
  );
}
