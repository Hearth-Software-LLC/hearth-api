import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizeSocialProfileVisible(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("socialProfileVisible must be a boolean");
  }
  return value;
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [profileLookup, publishedCountLookup] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("social_profile_visible")
      .eq("id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("recipes")
      .select("id", { count: "exact", head: true })
      .eq("created_by_profile_id", userId)
      .eq("source_name", "user")
      .eq("status", "published"),
  ]);

  const { data, error } = profileLookup;

  if (error) {
    return serverError("GET /api/me/social-visibility failed", "Failed to fetch social visibility", error);
  }

  if (publishedCountLookup.error) {
    return serverError(
      "GET /api/me/social-visibility published recipe count failed",
      "Failed to fetch social visibility",
      publishedCountLookup.error
    );
  }

  return NextResponse.json({
    socialProfileVisible: data?.social_profile_visible !== false,
    publishedRecipeCount: publishedCountLookup.count ?? 0,
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

  let socialProfileVisible: boolean;
  try {
    socialProfileVisible = normalizeSocialProfileVisible(payload.socialProfileVisible);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid social visibility setting");
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert(
      {
        id: userId,
        social_profile_visible: socialProfileVisible,
      },
      { onConflict: "id" }
    );

  if (error) {
    return serverError("PUT /api/me/social-visibility failed", "Failed to update social visibility", error);
  }

  let unpublishedRecipeCount = 0;
  if (!socialProfileVisible) {
    const { count, error: publishedCountError } = await supabaseAdmin
      .from("recipes")
      .select("id", { count: "exact", head: true })
      .eq("created_by_profile_id", userId)
      .eq("source_name", "user")
      .eq("status", "published");

    if (publishedCountError) {
      return serverError(
        "PUT /api/me/social-visibility published recipe count failed",
        "Failed to update social visibility",
        publishedCountError
      );
    }

    unpublishedRecipeCount = count ?? 0;

    if (unpublishedRecipeCount > 0) {
      const { error: unpublishError } = await supabaseAdmin
        .from("recipes")
        .update({ status: "unpublished" })
        .eq("created_by_profile_id", userId)
        .eq("source_name", "user")
        .eq("status", "published");

      if (unpublishError) {
        return serverError(
          "PUT /api/me/social-visibility bulk unpublish failed",
          "Failed to update social visibility",
          unpublishError
        );
      }
    }
  }

  return NextResponse.json({ ok: true, socialProfileVisible, unpublishedRecipeCount });
}
