"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase";

function pickHome(roles: string[]) {
  // Ajusta aquí si luego quieres otra lógica
  if (roles.includes("admin") || roles.includes("master")) return "/app/master";
  if (roles.includes("kitchen")) return "/app/kitchen";
  if (roles.includes("driver")) return "/app/driver";
  return "/app/advisor";
}

export default function HomePage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [msg, setMsg] = useState("Cargando…");

  useEffect(() => {
    (async () => {
      try {
        // 1) Session
        const { data: userRes, error: userErr } = await supabase.auth.getUser();
        if (userErr) {
          setMsg("Error auth: " + userErr.message);
          router.replace("/login");
          return;
        }

        if (!userRes.user) {
          setMsg("No session → /login");
          router.replace("/login");
          return;
        }

        // 2) Roles (tu fuente de verdad)
        const { data: roles, error: rolesErr } = await supabase.rpc("get_my_roles");
        if (rolesErr) {
          // Si falla roles, igual no te dejo en /, te mando a /app
          console.log("get_my_roles error:", rolesErr);
          setMsg("No pude leer roles → /app");
          router.replace("/app");
          return;
        }

        const roleList = (roles ?? []) as string[];
        const home = pickHome(roleList);

        setMsg("OK → " + home);
        router.replace(home);
      } catch (e: any) {
        console.log(e);
        setMsg("Error inesperado → /login");
        router.replace("/login");
      }
    })();
  }, [router, supabase]);

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 28, fontWeight: 900 }}>VIVO-OPS</h1>
      <p style={{ opacity: 0.8 }}>{msg}</p>
    </main>
  );
}