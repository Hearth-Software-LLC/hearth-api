import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

// The app calls this once the family's kitchen (recipes, tags, plans, grocery lists, household)
// is safely in iCloud. 30 days later public.bigtable_purge_moved_kitchens() deletes the server
// copy. Calling it again keeps the first date.

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const updateResult = await supabaseAdmin
    .from("profiles")
    .update({ kitchen_moved_at: new Date().toISOString() })
    .eq("id", userId)
    .is("kitchen_moved_at", null)
    .select("kitchen_moved_at");

  if (updateResult.error) {
    return serverError("POST /me/kitchen-moved update failed", "Failed to record the move", updateResult.error);
  }

  const updated = Array.isArray(updateResult.data) ? updateResult.data[0] : null;
  if (typeof updated?.kitchen_moved_at === "string") {
    return NextResponse.json({ movedAt: updated.kitchen_moved_at });
  }

  const existingResult = await supabaseAdmin
    .from("profiles")
    .select("kitchen_moved_at")
    .eq("id", userId)
    .maybeSingle();

  if (existingResult.error) {
    return serverError("POST /me/kitchen-moved lookup failed", "Failed to record the move", existingResult.error);
  }

  if (!existingResult.data) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ movedAt: existingResult.data.kitchen_moved_at ?? null });
}
