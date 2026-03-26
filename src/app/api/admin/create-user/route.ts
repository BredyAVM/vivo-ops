import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Role = "admin" | "master" | "advisor" | "kitchen" | "driver";

type CreateUserBody = {
  accessToken: string;
  email: string;
  password: string;
  full_name: string;
  is_active: boolean;
  roles: Role[];
};

function serverSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as CreateUserBody;

    if (!body?.accessToken) return NextResponse.json({ error: "Missing accessToken" }, { status: 401 });

    const supa = serverSupabase();

    // 1) validar actor desde token (el user que está logueado en tu app)
    const { data: userRes, error: userErr } = await supa.auth.getUser(body.accessToken);
    if (userErr || !userRes?.user) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

    const actorUserId = userRes.user.id;

    // 2) validar actor = master/admin (fuente de verdad: user_roles)
    const { data: actorRoles, error: rolesErr } = await supa
      .from("user_roles")
      .select("role")
      .eq("user_id", actorUserId);

    if (rolesErr) return NextResponse.json({ error: rolesErr.message }, { status: 400 });

    const roleList = (actorRoles ?? []).map((r: any) => String(r.role));
    const isMasterOrAdmin = roleList.includes("admin") || roleList.includes("master");
    if (!isMasterOrAdmin) return NextResponse.json({ error: "Only master/admin can create users" }, { status: 403 });

    // 3) validaciones básicas
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const full_name = String(body.full_name || "").trim();
    const is_active = Boolean(body.is_active);
    const roles = Array.isArray(body.roles) ? body.roles : [];

    if (!email || !email.includes("@")) return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    if (!password || password.length < 6) return NextResponse.json({ error: "Password must be at least 6 chars" }, { status: 400 });
    if (!full_name) return NextResponse.json({ error: "full_name is required" }, { status: 400 });
    if (roles.length === 0) return NextResponse.json({ error: "Select at least 1 role" }, { status: 400 });

    // 4) crear user en Auth (admin)
    const { data: created, error: createErr } = await supa.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (createErr || !created?.user) {
      return NextResponse.json({ error: createErr?.message ?? "Could not create user" }, { status: 400 });
    }

    const newUserId = created.user.id;

    // 5) crear profile
    const { error: profileErr } = await supa.from("profiles").insert({
      id: newUserId,
      full_name,
      is_active,
    });

    if (profileErr) {
      return NextResponse.json({ error: "Profile insert failed: " + profileErr.message }, { status: 400 });
    }

    // 6) asignar roles (multirol)
    const roleRows = roles.map((r) => ({ user_id: newUserId, role: r }));
    const { error: rolesInsErr } = await supa.from("user_roles").insert(roleRows);

    if (rolesInsErr) {
      return NextResponse.json({ error: "Roles insert failed: " + rolesInsErr.message }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      user_id: newUserId,
      email,
      full_name,
      roles,
      is_active,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}