import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { normalizeDisplayName } from "../lib/public-identity.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

// The name the community sees on a cook's recipes and profile. With the family's members moving
// to iCloud, this replaces "the organizer's first household member" as the public name.

type JsonObject = Record<string, unknown>;

export async function PUT(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: JsonObject;
  try {
    body = (await request.json()) as JsonObject;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body) || !("displayName" in body)) {
    return NextResponse.json({ error: "displayName is required (a string, or null to clear it)" }, { status: 400 });
  }

  let displayName: string | null;
  try {
    displayName = normalizeDisplayName(body.displayName);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid displayName" }, { status: 400 });
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ display_name: displayName })
    .eq("id", userId);

  if (error) {
    return serverError("PUT /me/public-profile failed", "Failed to update public profile", error);
  }

  return NextResponse.json({ displayName });
}
