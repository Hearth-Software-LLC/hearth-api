import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import { insertNotification } from "../lib/notifications.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

function extractDisplayName(profile: { household_name?: string | null } | null | undefined, fallback = "User") {
  const fromProfile = typeof profile?.household_name === "string" ? profile.household_name.trim() : "";
  return fromProfile || fallback;
}

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let membership;
  try {
    membership = await getMembershipContext(userId);
  } catch (error) {
    return serverError("POST /api/household/invitations membership lookup failed", "Failed to create invitation", error);
  }

  if (membership.role === "member") {
    return NextResponse.json({ error: "Only organizers can invite household members" }, { status: 403 });
  }

  let payload: JsonObject;
  try {
    payload = (await request.json()) as JsonObject;
  } catch {
    return badRequest("Request body must be valid JSON");
  }

  const inviteeProfileId = typeof payload.inviteeProfileId === "string" ? payload.inviteeProfileId.trim() : "";
  if (!inviteeProfileId) {
    return badRequest("inviteeProfileId is required");
  }
  if (inviteeProfileId === userId) {
    return badRequest("You cannot invite yourself");
  }

  const { data: inviteeProfile, error: inviteeProfileError } = await supabaseAdmin
    .from("profiles")
    .select("id, household_name")
    .eq("id", inviteeProfileId)
    .maybeSingle();

  if (inviteeProfileError) {
    return serverError("POST /api/household/invitations invitee lookup failed", "Failed to create invitation", inviteeProfileError);
  }
  if (!inviteeProfile) {
    return NextResponse.json({ error: "Invitee profile not found" }, { status: 404 });
  }

  const { data: blockedByInviteeRow, error: blockedByInviteeError } = await supabaseAdmin
    .from("blocks")
    .select("blocker_id")
    .eq("blocker_id", inviteeProfileId)
    .eq("blocked_id", userId)
    .maybeSingle();

  if (blockedByInviteeError) {
    return serverError("POST /api/household/invitations block check failed", "Failed to create invitation", blockedByInviteeError);
  }
  if (blockedByInviteeRow) {
    return conflict("This user has blocked you and cannot be invited");
  }

  const { data: existingPendingInvite, error: existingInviteError } = await supabaseAdmin
    .from("household_invitations")
    .select("id")
    .eq("organizer_id", userId)
    .eq("invitee_id", inviteeProfileId)
    .eq("status", "pending")
    .maybeSingle();

  if (existingInviteError) {
    return serverError("POST /api/household/invitations pending check failed", "Failed to create invitation", existingInviteError);
  }
  if (existingPendingInvite) {
    return conflict("An invitation is already pending for this user");
  }

  const { data: inviteeMembership, error: inviteeMembershipError } = await supabaseAdmin
    .from("household_memberships")
    .select("member_id")
    .eq("member_id", inviteeProfileId)
    .maybeSingle();

  if (inviteeMembershipError) {
    return serverError("POST /api/household/invitations membership check failed", "Failed to create invitation", inviteeMembershipError);
  }
  if (inviteeMembership) {
    const inviteeName = extractDisplayName(inviteeProfile, "This user");
    return conflict(
      `${inviteeName} is already a member of another household. They need to leave their current household before they can be invited to join another.`
    );
  }

  const { data: inviteeManagedMember, error: inviteeManagedMemberError } = await supabaseAdmin
    .from("household_memberships")
    .select("member_id")
    .eq("organizer_id", inviteeProfileId)
    .limit(1)
    .maybeSingle();

  if (inviteeManagedMemberError) {
    return serverError(
      "POST /api/household/invitations organizer household check failed",
      "Failed to create invitation",
      inviteeManagedMemberError
    );
  }
  if (inviteeManagedMember) {
    const inviteeName = extractDisplayName(inviteeProfile, "This user");
    return conflict(
      `${inviteeName} is the organizer of a household with joined members. They need to remove those members before they can join another household.`
    );
  }

  const organizerMemberCountResult = await supabaseAdmin
    .from("household_memberships")
    .select("member_id", { count: "exact", head: true })
    .eq("organizer_id", userId);

  if (organizerMemberCountResult.error) {
    return serverError(
      "POST /api/household/invitations organizer member cap check failed",
      "Failed to create invitation",
      organizerMemberCountResult.error
    );
  }
  if ((organizerMemberCountResult.count ?? 0) >= 10) {
    return conflict("Your household has reached the 10 joined-member limit");
  }

  const { data: invitation, error: insertInviteError } = await supabaseAdmin
    .from("household_invitations")
    .insert({
      organizer_id: userId,
      invitee_id: inviteeProfileId,
      status: "pending",
    })
    .select("id, organizer_id, invitee_id, status, created_at")
    .single();

  if (insertInviteError) {
    return serverError("POST /api/household/invitations insert failed", "Failed to create invitation", insertInviteError);
  }

  const { data: organizerProfile } = await supabaseAdmin
    .from("profiles")
    .select("id, household_name")
    .eq("id", userId)
    .maybeSingle();

  await insertNotification({
    recipientProfileId: inviteeProfileId,
    type: "household_invitation",
    actorProfileId: userId,
    data: {
      invitationId: invitation.id,
      organizerProfileId: userId,
      organizerHouseholdName: extractDisplayName(organizerProfile, "Organizer"),
    },
  });

  return NextResponse.json({
    invitation: {
      id: invitation.id,
      organizerProfileId: invitation.organizer_id,
      inviteeProfileId: invitation.invitee_id,
      status: invitation.status,
      createdAt: invitation.created_at,
    },
  });
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [sentResult, receivedResult] = await Promise.all([
    supabaseAdmin
      .from("household_invitations")
      .select("id, organizer_id, invitee_id, status, created_at")
      .eq("organizer_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
    supabaseAdmin
      .from("household_invitations")
      .select("id, organizer_id, invitee_id, status, created_at")
      .eq("invitee_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false }),
  ]);

  if (sentResult.error || receivedResult.error) {
    return serverError(
      "GET /api/household/invitations failed",
      "Failed to fetch invitations",
      sentResult.error ?? receivedResult.error
    );
  }

  const otherProfileIds = Array.from(new Set([
    ...(sentResult.data ?? []).map((row) => row.invitee_id),
    ...(receivedResult.data ?? []).map((row) => row.organizer_id),
  ]));

  let profileRows: Array<{ id: string; household_name: string | null; avatar_url: string | null }> = [];
  if (otherProfileIds.length > 0) {
    const profileResult = await supabaseAdmin
      .from("profiles")
      .select("id, household_name, avatar_url")
      .in("id", otherProfileIds);

    if (profileResult.error) {
      return serverError(
        "GET /api/household/invitations profiles lookup failed",
        "Failed to fetch invitations",
        profileResult.error
      );
    }

    profileRows = profileResult.data ?? [];
  }

  const profileById = profileRows.reduce<Record<string, { name: string | null; avatarUrl: string | null }>>((acc, row) => {
    acc[row.id] = {
      name: row.household_name,
      avatarUrl: toMemberAvatarPublicUrl(row.avatar_url),
    };
    return acc;
  }, {});

  return NextResponse.json({
    sent: (sentResult.data ?? []).map((invitation) => ({
      id: invitation.id,
      organizerProfileId: invitation.organizer_id,
      inviteeProfileId: invitation.invitee_id,
      status: invitation.status,
      createdAt: invitation.created_at,
      invitee: {
        profileId: invitation.invitee_id,
        profileName: profileById[invitation.invitee_id]?.name ?? null,
        avatarUrl: profileById[invitation.invitee_id]?.avatarUrl ?? null,
      },
    })),
    received: (receivedResult.data ?? []).map((invitation) => ({
      id: invitation.id,
      organizerProfileId: invitation.organizer_id,
      inviteeProfileId: invitation.invitee_id,
      status: invitation.status,
      createdAt: invitation.created_at,
      organizer: {
        profileId: invitation.organizer_id,
        profileName: profileById[invitation.organizer_id]?.name ?? null,
        avatarUrl: profileById[invitation.organizer_id]?.avatarUrl ?? null,
      },
    })),
  });
}
