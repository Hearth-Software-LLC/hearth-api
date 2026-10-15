import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function DELETE(request: Request, context: { params: Promise<{ profileId: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { profileId } = await context.params;
  const blockedProfileId = profileId.trim();
  if (!blockedProfileId) {
    return NextResponse.json({ error: "Invalid profile id" }, { status: 400 });
  }

  const deleteResult = await supabaseAdmin
    .from("blocks")
    .delete()
    .eq("blocker_id", userId)
    .eq("blocked_id", blockedProfileId);

  if (deleteResult.error) {
    return serverError("DELETE /api/blocks/[profileId] failed", "Failed to unblock user", deleteResult.error);
  }

  return NextResponse.json({ ok: true });
}
