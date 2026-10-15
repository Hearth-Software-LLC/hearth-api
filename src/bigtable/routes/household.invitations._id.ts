import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { insertNotification } from "../lib/notifications.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

function extractDisplayName(profile: { household_name?: string | null } | null | undefined, fallback = "User") {
  const name = typeof profile?.household_name === "string" ? profile.household_name.trim() : "";
  return name || fallback;
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const invitationId = id.trim();
  if (!invitationId) {
    return badRequest("Invalid invitation id");
  }

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const action = typeof payload.action === "string" ? payload.action.trim().toLowerCase() : "";
  if (action !== "accept" && action !== "decline" && action !== "cancel") {
    return badRequest("action must be accept, decline, or cancel");
  }

  const invitationResult = await supabaseAdmin
    .from("household_invitations")
    .select("id, organizer_id, invitee_id, status")
    .eq("id", invitationId)
    .maybeSingle();

  if (invitationResult.error) {
    return serverError("PUT /api/household/invitations/[id] lookup failed", "Failed to update invitation", invitationResult.error);
  }

  const invitation = invitationResult.data;
  if (!invitation) {
    return NextResponse.json({ error: "Invitation not found" }, { status: 404 });
  }

  if (action === "accept") {
    if (invitation.invitee_id !== userId) {
      return NextResponse.json({ error: "Only the invitee can accept this invitation" }, { status: 403 });
    }

    if (invitation.status === "accepted") {
      return NextResponse.json({ ok: true, status: "accepted", invitationId });
    }

    if (invitation.status !== "pending") {
      return conflict("This invitation is no longer available");
    }

    const [inviteeMembershipResult, inviteeManagedMembersResult] = await Promise.all([
      supabaseAdmin
        .from("household_memberships")
        .select("organizer_id")
        .eq("member_id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("household_memberships")
        .select("member_id")
        .eq("organizer_id", userId)
        .limit(1)
        .maybeSingle(),
    ]);

    if (inviteeMembershipResult.error || inviteeManagedMembersResult.error) {
      return serverError(
        "PUT /api/household/invitations/[id] accept validations failed",
        "Failed to update invitation",
        inviteeMembershipResult.error ?? inviteeManagedMembersResult.error
      );
    }

    if (inviteeMembershipResult.data) {
      return conflict("You are already a member of a household");
    }

    if (inviteeManagedMembersResult.data) {
      return conflict(
        "You're the organizer of a household with joined members. Remove those members before joining another household."
      );
    }

    const acceptResult = await supabaseAdmin.rpc("accept_household_invitation", {
      p_invitation_id: invitationId,
      p_invitee_id: userId,
    });

    if (acceptResult.error) {
      return serverError("PUT /api/household/invitations/[id] accept failed", "Failed to update invitation", acceptResult.error);
    }

    if (!acceptResult.data) {
      return conflict("This invitation is no longer available");
    }

    const [inviteeProfileResult, organizerProfileResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, household_name")
        .eq("id", userId)
        .maybeSingle(),
      supabaseAdmin
        .from("profiles")
        .select("id, household_name")
        .eq("id", invitation.organizer_id)
        .maybeSingle(),
    ]);

    // Create a default all-false permissions row for the new member.
    await supabaseAdmin
      .from("household_member_permissions")
      .upsert({ member_id: userId }, { onConflict: "member_id" });

    await insertNotification({
      recipientProfileId: invitation.organizer_id,
      type: "household_invitation_accepted",
      actorProfileId: userId,
      data: {
        memberProfileId: userId,
        memberName: extractDisplayName(inviteeProfileResult.data, "A member"),
        organizerHouseholdName: extractDisplayName(organizerProfileResult.data, "Your household"),
      },
    });

    return NextResponse.json({ ok: true, status: "accepted", invitationId });
  }

  if (action === "decline") {
    if (invitation.invitee_id !== userId) {
      return NextResponse.json({ error: "Only the invitee can decline this invitation" }, { status: 403 });
    }

    if (invitation.status === "declined") {
      return NextResponse.json({ ok: true, status: "declined", invitationId });
    }

    if (invitation.status !== "pending") {
      return conflict("This invitation is no longer available");
    }

    const declineUpdate = await supabaseAdmin
      .from("household_invitations")
      .update({ status: "declined", resolved_at: new Date().toISOString() })
      .eq("id", invitationId)
      .eq("status", "pending");

    if (declineUpdate.error) {
      return serverError("PUT /api/household/invitations/[id] decline failed", "Failed to update invitation", declineUpdate.error);
    }

    const inviteeProfileResult = await supabaseAdmin
      .from("profiles")
      .select("id, household_name")
      .eq("id", userId)
      .maybeSingle();

    await insertNotification({
      recipientProfileId: invitation.organizer_id,
      type: "household_invitation_declined",
      actorProfileId: userId,
      data: {
        memberProfileId: userId,
        memberName: extractDisplayName(inviteeProfileResult.data, "A member"),
      },
    });

    return NextResponse.json({ ok: true, status: "declined", invitationId });
  }

  if (invitation.organizer_id !== userId) {
    return NextResponse.json({ error: "Only the organizer can cancel this invitation" }, { status: 403 });
  }

  if (invitation.status === "cancelled") {
    return NextResponse.json({ ok: true, status: "cancelled", invitationId });
  }

  if (invitation.status !== "pending") {
    return conflict("This invitation is no longer available");
  }

  const cancelUpdate = await supabaseAdmin
    .from("household_invitations")
    .update({ status: "cancelled", resolved_at: new Date().toISOString() })
    .eq("id", invitationId)
    .eq("status", "pending");

  if (cancelUpdate.error) {
    return serverError("PUT /api/household/invitations/[id] cancel failed", "Failed to update invitation", cancelUpdate.error);
  }

  return NextResponse.json({ ok: true, status: "cancelled", invitationId });
}
