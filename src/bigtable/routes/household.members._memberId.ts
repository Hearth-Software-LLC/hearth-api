import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { insertNotification } from "../lib/notifications.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

function extractDisplayName(profile: { household_name?: string | null } | null | undefined, fallback = "User") {
  const name = typeof profile?.household_name === "string" ? profile.household_name.trim() : "";
  return name || fallback;
}

export async function DELETE(request: Request, context: { params: Promise<{ memberId: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { memberId } = await context.params;
  const targetMemberId = memberId.trim();
  if (!targetMemberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  const membershipResult = await supabaseAdmin
    .from("household_memberships")
    .select("member_id, organizer_id")
    .eq("member_id", targetMemberId)
    .maybeSingle();

  if (membershipResult.error) {
    return serverError("DELETE /api/household/members/[memberId] membership lookup failed", "Failed to remove member", membershipResult.error);
  }

  if (!membershipResult.data) {
    return NextResponse.json({ error: "Membership not found" }, { status: 404 });
  }

  const organizerId = membershipResult.data.organizer_id;
  const isMemberLeaving = userId === targetMemberId;
  const isOrganizerRemoving = userId === organizerId;

  if (!isMemberLeaving && !isOrganizerRemoving) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const removeResult = await supabaseAdmin.rpc("remove_household_member", {
    p_member_id: targetMemberId,
    p_requester_id: userId,
  });

  if (removeResult.error) {
    return serverError("DELETE /api/household/members/[memberId] remove failed", "Failed to remove member", removeResult.error);
  }

  if (!removeResult.data) {
    return NextResponse.json({ error: "Membership not found" }, { status: 404 });
  }

  const [memberProfileResult, organizerProfileResult] = await Promise.all([
    supabaseAdmin
      .from("profiles")
      .select("id, household_name")
      .eq("id", targetMemberId)
      .maybeSingle(),
    supabaseAdmin
      .from("profiles")
      .select("id, household_name")
      .eq("id", organizerId)
      .maybeSingle(),
  ]);

  if (isOrganizerRemoving) {
    await insertNotification({
      recipientProfileId: targetMemberId,
      type: "household_member_removed",
      actorProfileId: userId,
      data: {
        organizerProfileId: organizerId,
        organizerHouseholdName: extractDisplayName(organizerProfileResult.data, "Organizer"),
      },
    });

    return NextResponse.json({ ok: true, action: "removed", memberId: targetMemberId });
  }

  await insertNotification({
    recipientProfileId: organizerId,
    type: "household_member_left",
    actorProfileId: targetMemberId,
    data: {
      memberProfileId: targetMemberId,
      memberName: extractDisplayName(memberProfileResult.data, "A member"),
    },
  });

  return NextResponse.json({ ok: true, action: "left", memberId: targetMemberId });
}
