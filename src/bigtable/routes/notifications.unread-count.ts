import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { count, error } = await supabaseAdmin
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("recipient_profile_id", userId)
    .is("read_at", null);

  if (error) {
    return serverError("GET /api/notifications/unread-count failed", "Failed to fetch unread count", error);
  }

  return NextResponse.json(
    { unreadCount: typeof count === "number" ? count : 0 },
    { headers: { "Cache-Control": "private, max-age=30" } }
  );
}
