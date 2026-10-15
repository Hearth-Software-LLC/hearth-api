import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

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
    .from("blocks")
    .select("blocked_id, created_at")
    .eq("blocker_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    return serverError("GET /api/blocks failed", "Failed to load blocked users", error);
  }

  return NextResponse.json({
    blockedProfileIds: (data ?? [])
      .map((row) => (typeof row.blocked_id === "string" ? row.blocked_id : ""))
      .filter(Boolean),
  });
}

export async function POST(request: Request) {
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

  const blockedProfileId = typeof payload.blockedProfileId === "string" ? payload.blockedProfileId.trim() : "";
  if (!blockedProfileId) {
    return badRequest("blockedProfileId is required");
  }

  if (blockedProfileId === userId) {
    return badRequest("You cannot block yourself");
  }

  const { data: blockedProfile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id")
    .eq("id", blockedProfileId)
    .maybeSingle();

  if (profileError) {
    return serverError("POST /api/blocks profile lookup failed", "Failed to block user", profileError);
  }

  if (!blockedProfile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const [targetIsCallerMemberResult, callerIsTargetMemberResult] = await Promise.all([
    supabaseAdmin
      .from("household_memberships")
      .select("member_id")
      .eq("organizer_id", userId)
      .eq("member_id", blockedProfileId)
      .maybeSingle(),
    supabaseAdmin
      .from("household_memberships")
      .select("member_id")
      .eq("organizer_id", blockedProfileId)
      .eq("member_id", userId)
      .maybeSingle(),
  ]);

  if (targetIsCallerMemberResult.error || callerIsTargetMemberResult.error) {
    return serverError(
      "POST /api/blocks household membership lookup failed",
      "Failed to block user",
      targetIsCallerMemberResult.error ?? callerIsTargetMemberResult.error
    );
  }

  if (targetIsCallerMemberResult.data || callerIsTargetMemberResult.data) {
    return NextResponse.json(
      {
        error: "You can't block someone while they are a member of your household or you are a member of theirs.",
      },
      { status: 409 }
    );
  }

  const upsertBlockResult = await supabaseAdmin
    .from("blocks")
    .upsert({
      blocker_id: userId,
      blocked_id: blockedProfileId,
      created_at: new Date().toISOString(),
    });

  if (upsertBlockResult.error) {
    return serverError("POST /api/blocks upsert failed", "Failed to block user", upsertBlockResult.error);
  }

  const removeFollowsResult = await supabaseAdmin
    .from("follows")
    .delete()
    .or(`and(follower_profile_id.eq.${userId},followee_profile_id.eq.${blockedProfileId}),and(follower_profile_id.eq.${blockedProfileId},followee_profile_id.eq.${userId})`);

  if (removeFollowsResult.error) {
    return serverError("POST /api/blocks follows cleanup failed", "Failed to block user", removeFollowsResult.error);
  }

  const cancelInvitesResult = await supabaseAdmin
    .from("household_invitations")
    .update({
      status: "cancelled",
      resolved_at: new Date().toISOString(),
    })
    .eq("status", "pending")
    .or(`and(organizer_id.eq.${userId},invitee_id.eq.${blockedProfileId}),and(organizer_id.eq.${blockedProfileId},invitee_id.eq.${userId})`);

  if (cancelInvitesResult.error) {
    return serverError("POST /api/blocks invitation cleanup failed", "Failed to block user", cancelInvitesResult.error);
  }

  return NextResponse.json({ ok: true });
}
