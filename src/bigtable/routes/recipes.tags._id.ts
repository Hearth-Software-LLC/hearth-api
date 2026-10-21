import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { normalizeCustomTagLabel } from "../lib/recipe-tags.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

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

  // Rename + cascade into the caller's recipes atomically. The RPC scopes every
  // write to p_profile_id, so a user cannot rename another user's tag.
  const { data, error } = await supabaseAdmin.rpc("rename_custom_recipe_tag", {
    p_profile_id: userId,
    p_tag_id: id,
    p_new_label: label,
    p_new_normalized: normalized,
  });

  if (error) {
    // Collision with another of the caller's existing tags.
    if (error.code === "23505") {
      return NextResponse.json({ error: "A tag with that name already exists" }, { status: 409 });
    }
    return serverError("PATCH /api/recipes/tags/[id] rename failed", "Failed to update tag", error);
  }

  // Null return means the tag does not exist or is not owned by the caller.
  if (!data) {
    return NextResponse.json({ error: "Tag not found" }, { status: 404 });
  }

  return NextResponse.json({ tag: { id, label, normalized } });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;

  // Catalog-only delete: removes the reusable tag but leaves the literal tag
  // string on any recipes that already use it. Scoped to the caller's own tags.
  const { data, error } = await supabaseAdmin
    .from("custom_recipe_tags")
    .delete()
    .eq("id", id)
    .eq("profile_id", userId)
    .select("id")
    .maybeSingle();

  if (error) {
    return serverError("DELETE /api/recipes/tags/[id] failed", "Failed to delete tag", error);
  }

  if (!data) {
    return NextResponse.json({ error: "Tag not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
