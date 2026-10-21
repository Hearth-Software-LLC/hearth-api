import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { insertNotification } from "../lib/notifications.js";
import { loadPublicDisplayName } from "../lib/public-identity.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { permissionsFor, type Role } from "./household.members.js";

// Joining a household with its join code. Creates the same membership the invitation-accept path
// does (via the bigtable_join_household SQL helper, the invitation-free twin of
// accept_household_invitation) and sets the member's permissions from their household role
// (`role`: parent, adult or kid; adult when missing). The organizer's app corrects the role
// later if it differs (PUT /household/members).

type JsonObject = Record<string, unknown>;

const MAX_CODE_LENGTH = 128;

function conflict(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

function notFound() {
  return NextResponse.json({ error: "That code doesn't match a household" }, { status: 404 });
}

function nameOf(profile: { household_name?: string | null } | null | undefined, fallback: string) {
  const name = typeof profile?.household_name === "string" ? profile.household_name.trim() : "";
  return name || fallback;
}

export async function POST(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: JsonObject;
  try {
    body = (await request.json()) as JsonObject;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const code = typeof body?.code === "string" ? body.code.trim() : "";
  if (!code || code.length > MAX_CODE_LENGTH) {
    return NextResponse.json({ error: "code is required" }, { status: 400 });
  }

  const rawRole = body?.role;
  if (rawRole !== undefined && rawRole !== "parent" && rawRole !== "adult" && rawRole !== "kid") {
    return NextResponse.json({ error: "role must be parent, adult or kid" }, { status: 400 });
  }
  const role: Role = rawRole ?? "adult";

  const codeResult = await supabaseAdmin
    .from("bigtable_join_codes")
    .select("organizer_id")
    .eq("code", code)
    .maybeSingle();

  if (codeResult.error) {
    return serverError("POST /household/join code lookup failed", "Failed to join household", codeResult.error);
  }

  const organizerId = typeof codeResult.data?.organizer_id === "string" ? codeResult.data.organizer_id : null;
  if (!organizerId) {
    return notFound();
  }

  if (organizerId === userId) {
    return conflict("That's your own household's code");
  }

  const [callerMembershipResult, callerManagedMembersResult, organizerMembershipResult, blocksResult] = await Promise.all([
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
    supabaseAdmin
      .from("household_memberships")
      .select("organizer_id")
      .eq("member_id", organizerId)
      .maybeSingle(),
    supabaseAdmin
      .from("blocks")
      .select("blocker_id")
      .or(`and(blocker_id.eq.${userId},blocked_id.eq.${organizerId}),and(blocker_id.eq.${organizerId},blocked_id.eq.${userId})`)
      .limit(1),
  ]);

  const lookupError = callerMembershipResult.error
    ?? callerManagedMembersResult.error
    ?? organizerMembershipResult.error
    ?? blocksResult.error;
  if (lookupError) {
    return serverError("POST /household/join validations failed", "Failed to join household", lookupError);
  }

  const currentOrganizerId = callerMembershipResult.data?.organizer_id ?? null;
  if (currentOrganizerId === organizerId) {
    return NextResponse.json({ organizerProfileId: organizerId });
  }

  if (currentOrganizerId) {
    return conflict("You're already a member of another household. Leave it before joining this one.");
  }

  if (callerManagedMembersResult.data) {
    return conflict(
      "You're the organizer of a household with joined members. Remove those members before joining another household."
    );
  }

  // The code's owner has since joined someone else's household; their code no longer leads anywhere.
  if (organizerMembershipResult.data) {
    return notFound();
  }

  if (Array.isArray(blocksResult.data) && blocksResult.data.length > 0) {
    return notFound();
  }

  const joinResult = await supabaseAdmin.rpc("bigtable_join_household", {
    p_member_id: userId,
    p_organizer_id: organizerId,
  });

  if (joinResult.error) {
    return serverError("POST /household/join failed", "Failed to join household", joinResult.error);
  }

  if (!joinResult.data) {
    return conflict("You're already a member of another household. Leave it before joining this one.");
  }

  // What they can do with the organizer's plan follows their household role.
  const permissionsResult = await supabaseAdmin
    .from("household_member_permissions")
    .upsert(
      {
        member_id: userId,
        ...permissionsFor(role),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "member_id" }
    );

  if (permissionsResult.error) {
    return serverError("POST /household/join permissions failed", "Failed to join household", permissionsResult.error);
  }

  try {
    const [memberProfileResult, organizerProfileResult, memberDisplayName] = await Promise.all([
      supabaseAdmin.from("profiles").select("id, household_name").eq("id", userId).maybeSingle(),
      supabaseAdmin.from("profiles").select("id, household_name").eq("id", organizerId).maybeSingle(),
      loadPublicDisplayName(userId),
    ]);

    await insertNotification({
      recipientProfileId: organizerId,
      type: "household_invitation_accepted",
      actorProfileId: userId,
      data: {
        memberProfileId: userId,
        memberName: memberDisplayName ?? nameOf(memberProfileResult.data, "A member"),
        organizerHouseholdName: nameOf(organizerProfileResult.data, "Your household"),
        via: "join_code",
      },
    });
  } catch (error) {
    // The join already happened; a failed notification shouldn't undo it for the client.
    console.warn("POST /household/join notification failed", error);
  }

  return NextResponse.json({ organizerProfileId: organizerId });
}
