import { NextRequest, NextResponse } from "../next-shim.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";

type ResetPayload = {
  email?: unknown;
  password?: unknown;
};

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequestResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

async function findUserByEmail(email: string) {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) {
    throw error;
  }

  return data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

async function ensureProfileRow(userId: string) {
  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        id: userId,
        household_name: null,
        avatar_url: null,
      },
      { onConflict: "id" }
    );

  if (error) {
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const configuredToken = process.env.MAESTRO_RESET_TOKEN;
  if (!configuredToken) {
    return NextResponse.json({ error: "Reset token is not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization") ?? "";
  if (authHeader !== `Bearer ${configuredToken}`) {
    return unauthorizedResponse();
  }

  let body: ResetPayload;
  try {
    body = (await request.json()) as ResetPayload;
  } catch {
    return badRequestResponse("Invalid JSON payload");
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email) {
    return badRequestResponse("email is required");
  }

  if (!password) {
    return badRequestResponse("password is required");
  }

  try {
    const existingUser = await findUserByEmail(email);
    let userId = existingUser?.id ?? null;

    if (existingUser) {
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(existingUser.id, {
        password,
      });
      if (updateError) {
        throw updateError;
      }
    } else {
      const { data, error: createError } = await supabaseAdmin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      if (createError) {
        throw createError;
      }

      userId = data.user?.id ?? null;
    }

    if (!userId) {
      throw new Error("Failed to resolve Maestro user id");
    }

    await ensureProfileRow(userId);

    return NextResponse.json({
      ok: true,
      email,
      userId,
      action: existingUser ? "updated" : "created",
    });
  } catch (error) {
    return serverError("POST /api/maestro/reset", "Failed to reset Maestro user", error);
  }
}