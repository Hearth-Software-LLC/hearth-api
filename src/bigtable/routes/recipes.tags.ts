import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { normalizeCustomTagLabel } from "../lib/recipe-tags.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";

export type CustomTagRow = {
  id: string;
  label: string;
  normalized: string;
};

export function toCustomTagDto(row: CustomTagRow) {
  return { id: row.id, label: row.label, normalized: row.normalized };
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("custom_recipe_tags")
    .select("id, label, normalized")
    .eq("profile_id", userId)
    .order("label", { ascending: true });

  if (error) {
    return serverError("GET /api/recipes/tags query failed", "Failed to fetch tags", error);
  }

  return NextResponse.json({ tags: (data ?? []).map(toCustomTagDto) });
}

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  let label: string;
  let normalized: string;
  try {
    ({ label, normalized } = normalizeCustomTagLabel(body.label));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid label" }, { status: 400 });
  }

  // profile_id is derived solely from the verified token, never from the body.
  const { data, error } = await supabaseAdmin
    .from("custom_recipe_tags")
    .insert({ profile_id: userId, label, normalized })
    .select("id, label, normalized")
    .single();

  if (error) {
    // Unique violation on (profile_id, normalized): the tag already exists.
    if (error.code === "23505") {
      const { data: existing } = await supabaseAdmin
        .from("custom_recipe_tags")
        .select("id, label, normalized")
        .eq("profile_id", userId)
        .eq("normalized", normalized)
        .maybeSingle();

      if (existing) {
        return NextResponse.json({ tag: toCustomTagDto(existing) }, { status: 200 });
      }
    }
    return serverError("POST /api/recipes/tags insert failed", "Failed to create tag", error);
  }

  return NextResponse.json({ tag: toCustomTagDto(data) }, { status: 201 });
}
