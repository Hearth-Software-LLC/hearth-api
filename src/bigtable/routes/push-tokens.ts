import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("push_tokens")
    .select("token, platform, updated_at")
    .eq("profile_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    return serverError("GET /api/push-tokens failed", "Failed to fetch push tokens", error);
  }

  return NextResponse.json({
    tokens: (data ?? []).map((row) => ({
      token: row.token,
      platform: row.platform,
      updatedAt: row.updated_at,
    })),
  });
}

export async function PUT(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const token = payload.token;
  const enabled = payload.enabled;
  const platform = payload.platform;

  if (typeof token !== "string" || token.trim().length === 0) {
    return badRequest("token is required");
  }
  if (typeof enabled !== "boolean") {
    return badRequest("enabled must be a boolean");
  }

  const normalizedToken = token.trim();
  const normalizedPlatform = typeof platform === "string" && platform.trim().length > 0
    ? platform.trim().toLowerCase().slice(0, 20)
    : null;

  if (enabled) {
    const { error } = await supabaseAdmin
      .from("push_tokens")
      .upsert({
        profile_id: userId,
        token: normalizedToken,
        platform: normalizedPlatform,
        updated_at: new Date().toISOString(),
      });

    if (error) {
      return serverError("PUT /api/push-tokens register failed", "Failed to update push token", error);
    }
  } else {
    const { error } = await supabaseAdmin
      .from("push_tokens")
      .delete()
      .eq("profile_id", userId)
      .eq("token", normalizedToken);

    if (error) {
      return serverError("PUT /api/push-tokens unregister failed", "Failed to update push token", error);
    }
  }

  return NextResponse.json({ ok: true });
}
