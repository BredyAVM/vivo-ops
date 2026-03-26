"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase";

function pickHome(roles: string[]) {
  if (roles.includes("admin") || roles.includes("master")) return "/app/master";
  if (roles.includes("kitchen")) return "/app/kitchen";
  if (roles.includes("driver")) return "/app/driver";
  return "/app/advisor";
}

export default function AppRoot() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      const supabase = createSupabaseBrowser();
      const { data: authRes } = await supabase.auth.getUser();
      if (!authRes.user) {
        router.push("/login");
        return;
      }
      const { data } = await supabase.rpc("get_my_roles");
      router.push(pickHome((data ?? []) as string[]));
    })();
  }, [router]);

  return <div>Cargando...</div>;
}