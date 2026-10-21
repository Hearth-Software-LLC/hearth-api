import { NextRequest, NextResponse } from "../next-shim.js";
import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getMembershipContext } from "../lib/household.js";
import { ensureRevenueCatSubscriber } from "../../services/revenuecat.js";
import { supabaseAdmin } from "../../services/supabase.js";
import { serverError } from "../lib/server-error.js";
import { ApiError } from "../../errors.js";
import { AccountDeletionError, deleteHearthAccount } from "../../services/account-deletion.js";

export const dynamic = "force-dynamic";

type HouseholdMemberInput = {
  id?: string | null;
  name: string;
  dateOfBirth?: string | null;
  date_of_birth?: string | null;
  likes?: string[];
  dislikes?: string[];
  avatarUrl?: string | null;
};

type DietaryRestrictionInput = {
  type: string;
  value: string;
};

type MeUpdatePayload = {
  householdName?: string;
  avatarUrl?: string | null;
  householdMembers?: HouseholdMemberInput[];
  dietaryRestrictions?: DietaryRestrictionInput[];
};

type MePatchPayload = {
  tutorialComplete?: boolean;
};

type ProfileRow = {
  id: string;
  household_name: string | null;
  avatar_url: string | null;
  created_at: string;
  social_profile_visible: boolean | null;
  tutorial_complete?: boolean | null;
};

const PROFILE_SELECT_WITH_TUTORIAL = "id, household_name, avatar_url, created_at, social_profile_visible, tutorial_complete";
const PROFILE_SELECT_FALLBACK = "id, household_name, avatar_url, created_at, social_profile_visible";

function isMissingTutorialCompleteColumnError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const parsed = error as { message?: unknown; details?: unknown; hint?: unknown };
  const message = `${typeof parsed.message === "string" ? parsed.message : ""} ${typeof parsed.details === "string" ? parsed.details : ""} ${typeof parsed.hint === "string" ? parsed.hint : ""}`.toLowerCase();

  return message.includes("tutorial_complete") && (message.includes("column") || message.includes("schema cache"));
}

async function getProfileRow(profileId: string): Promise<{ data: ProfileRow | null; error: unknown | null }> {
  const primaryResult = await supabaseAdmin
    .from("profiles")
    .select(PROFILE_SELECT_WITH_TUTORIAL)
    .eq("id", profileId)
    .maybeSingle();

  if (!primaryResult.error) {
    return {
      data: primaryResult.data as ProfileRow | null,
      error: null,
    };
  }

  if (!isMissingTutorialCompleteColumnError(primaryResult.error)) {
    return { data: null, error: primaryResult.error };
  }

  const fallbackResult = await supabaseAdmin
    .from("profiles")
    .select(PROFILE_SELECT_FALLBACK)
    .eq("id", profileId)
    .maybeSingle();

  if (fallbackResult.error) {
    return { data: null, error: fallbackResult.error };
  }

  return {
    data: fallbackResult.data
      ? {
        ...(fallbackResult.data as Omit<ProfileRow, "tutorial_complete">),
        tutorial_complete: false,
      }
      : null,
    error: null,
  };
}

function unauthorizedResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

function badRequestResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function conflictResponse(message: string) {
  return NextResponse.json({ error: message }, { status: 409 });
}

function isValidIsoDateOnly(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeHouseholdMember(member: HouseholdMemberInput) {
  if (typeof member?.name !== "string") {
    throw new Error("Each household member must include a name");
  }

  const name = member.name.trim();
  if (!name) {
    return null;
  }
  if (name.length > 80) {
    throw new Error("Household member names must be 80 characters or fewer");
  }

  const id = typeof member.id === "string" && member.id.trim() ? member.id.trim() : null;

  const dateOfBirthCandidate = member.dateOfBirth ?? member.date_of_birth ?? null;
  if (dateOfBirthCandidate !== null && dateOfBirthCandidate !== undefined) {
    if (typeof dateOfBirthCandidate !== "string") {
      throw new Error("Household member dateOfBirth must be a string in YYYY-MM-DD format");
    }
    const trimmed = dateOfBirthCandidate.trim();
    if (!isValidIsoDateOnly(trimmed)) {
      throw new Error("Household member dateOfBirth must use YYYY-MM-DD format");
    }
    const parsed = new Date(`${trimmed}T00:00:00.000Z`);
    if (parsed.getTime() > Date.now()) {
      throw new Error("Household member dateOfBirth cannot be in the future");
    }
  }

  const avatarUrl = member.avatarUrl ?? null;
  if (avatarUrl !== null && typeof avatarUrl !== "string") {
    throw new Error("Household member avatarUrl must be a string or null");
  }

  const likes = Array.isArray(member.likes) ? member.likes : [];
  if (!Array.isArray(likes) || likes.some((entry) => typeof entry !== "string")) {
    throw new Error("Household member likes must be an array of strings");
  }
  const normalizedLikes = likes
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, 50))
    .slice(0, 20);

  const dislikes = Array.isArray(member.dislikes) ? member.dislikes : [];
  if (!Array.isArray(dislikes) || dislikes.some((entry) => typeof entry !== "string")) {
    throw new Error("Household member dislikes must be an array of strings");
  }
  const normalizedDislikes = dislikes
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.slice(0, 50))
    .slice(0, 20);

  return {
    id,
    name,
    dateOfBirth: typeof dateOfBirthCandidate === "string" && dateOfBirthCandidate.trim()
      ? dateOfBirthCandidate.trim()
      : null,
    likes: normalizedLikes,
    dislikes: normalizedDislikes,
    avatarUrl: avatarUrl ? avatarUrl.trim() || null : null,
  };
}

function normalizeDietaryRestrictions(rawRestrictions: unknown): DietaryRestrictionInput[] {
  const restrictions = rawRestrictions ?? [];
  if (!Array.isArray(restrictions)) {
    throw new Error("dietaryRestrictions must be an array");
  }

  const dietaryRestrictions = restrictions
    .map((restriction) => {
      if (typeof restriction?.type !== "string" || typeof restriction?.value !== "string") {
        throw new Error("Each dietary restriction must include type and value");
      }

      const type = restriction.type.trim();
      const value = restriction.value.trim();

      if (!type || !value) {
        return null;
      }
      if (type.length > 40 || value.length > 80) {
        throw new Error("Dietary restriction type/value is too long");
      }

      return { type, value };
    })
    .filter((restriction): restriction is DietaryRestrictionInput => restriction !== null);

  if (dietaryRestrictions.length > 50) {
    throw new Error("A maximum of 50 dietary restrictions is allowed");
  }

  return dietaryRestrictions;
}

function normalizePayload(body: MeUpdatePayload): {
  householdName: string | null;
  avatarUrl: string | null;
  householdMembers: Array<{
    id: string | null;
    name: string;
    dateOfBirth: string | null;
    likes: string[];
    dislikes: string[];
    avatarUrl: string | null;
  }>;
  dietaryRestrictions: DietaryRestrictionInput[];
} {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Invalid request body");
  }

  const householdName = typeof body.householdName === "string" ? body.householdName.trim() : "";
  if (!householdName) {
    throw new Error("householdName is required");
  }
  if (householdName.length > 120) {
    throw new Error("householdName must be 120 characters or fewer");
  }

  const avatarUrl = body.avatarUrl ?? null;
  if (avatarUrl !== null && typeof avatarUrl !== "string") {
    throw new Error("avatarUrl must be a string or null");
  }

  const rawMembers = body.householdMembers ?? [];
  if (!Array.isArray(rawMembers)) {
    throw new Error("householdMembers must be an array");
  }

  const householdMembers = rawMembers
    .map((member) => normalizeHouseholdMember(member))
    .filter((member): member is {
      id: string | null;
      name: string;
      dateOfBirth: string | null;
      likes: string[];
      dislikes: string[];
      avatarUrl: string | null;
    } => member !== null);

  if (householdMembers.length === 0) {
    throw new Error("At least one household member is required");
  }
  if (householdMembers.length > 20) {
    throw new Error("A maximum of 20 household members is allowed");
  }

  const dietaryRestrictions = normalizeDietaryRestrictions(body.dietaryRestrictions);

  return {
    householdName,
    avatarUrl: avatarUrl ? avatarUrl.trim() || null : null,
    householdMembers,
    dietaryRestrictions,
  };
}

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  try {
    // Best-effort sync so support can manage this user in RevenueCat before purchases.
    await ensureRevenueCatSubscriber(userId);
  } catch (error) {
    console.warn("GET /api/me revenuecat subscriber sync skipped", error);
  }

  let membership;
  try {
    membership = await getMembershipContext(userId);
  } catch (error) {
    return serverError("GET /api/me failed", "Failed to fetch profile", error);
  }

  const effectiveProfileId = membership.organizerProfileId;

  const [
    profileResult,
    membersResult,
    restrictionsResult,
    myMemberResult,
    myProfileResult,
    pendingInvitationCountResult,
  ] = await Promise.all([
    getProfileRow(effectiveProfileId),
    supabaseAdmin
      .from("household_members")
      .select("id, linked_profile_id, name, date_of_birth, likes, dislikes, avatar_url, created_at")
      .eq("profile_id", effectiveProfileId)
      .order("created_at", { ascending: true }),
    supabaseAdmin
      .from("dietary_restrictions")
      .select("id, type, value")
      .eq("profile_id", effectiveProfileId),
    supabaseAdmin
      .from("household_members")
      .select("id, name, avatar_url")
      .eq("profile_id", userId)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("profiles")
      .select("id, household_name, avatar_url")
      .eq("id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("household_invitations")
      .select("id", { count: "exact", head: true })
      .eq("invitee_id", userId)
      .eq("status", "pending"),
  ]);

  if (
    profileResult.error
    || membersResult.error
    || restrictionsResult.error
    || myMemberResult.error
    || myProfileResult.error
    || pendingInvitationCountResult.error
  ) {
    return serverError(
      "GET /api/me failed",
      "Failed to fetch profile",
      profileResult.error
      ?? membersResult.error
      ?? restrictionsResult.error
      ?? myMemberResult.error
      ?? myProfileResult.error
      ?? pendingInvitationCountResult.error
    );
  }

  const myMember = myMemberResult.data
    ? {
      id: myMemberResult.data.id,
      name: myMemberResult.data.name,
      avatar_url: myMemberResult.data.avatar_url,
    }
    : {
      id: myProfileResult.data?.id ?? userId,
      name: myProfileResult.data?.household_name ?? null,
      avatar_url: myProfileResult.data?.avatar_url ?? null,
    };

  return NextResponse.json(
    {
      profile: profileResult.data,
      householdMembers: membersResult.data ?? [],
      dietaryRestrictions: restrictionsResult.data ?? [],
      myMember,
      membership: {
        role: membership.role,
        organizerProfileId: membership.organizerProfileId,
        organizerHouseholdName: profileResult.data?.household_name ?? null,
        pendingInvitationCount: pendingInvitationCountResult.count ?? 0,
      },
    },
    {
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
        Vary: "Authorization",
      },
    }
  );
}

export async function PUT(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  let body: MeUpdatePayload;
  try {
    body = (await request.json()) as MeUpdatePayload;
  } catch {
    return badRequestResponse("Request body must be valid JSON");
  }

  let membership;
  try {
    membership = await getMembershipContext(userId);
  } catch (error) {
    return serverError("PUT /api/me membership lookup failed", "Failed to save profile", error);
  }

  if (membership.role === "member") {
    const organizerId = membership.organizerProfileId;

    const [organizerProfileResult, linkedMemberResult] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, household_name")
        .eq("id", organizerId)
        .maybeSingle(),
      supabaseAdmin
        .from("household_members")
        .select("id, name, date_of_birth, likes, dislikes, avatar_url")
        .eq("profile_id", organizerId)
        .eq("linked_profile_id", userId)
        .maybeSingle(),
    ]);

    if (organizerProfileResult.error || linkedMemberResult.error) {
      return serverError(
        "PUT /api/me member lookup failed",
        "Failed to save profile",
        organizerProfileResult.error ?? linkedMemberResult.error
      );
    }

    const incomingHouseholdName = typeof body.householdName === "string" ? body.householdName.trim() : "";
    if (incomingHouseholdName && incomingHouseholdName !== (organizerProfileResult.data?.household_name ?? "")) {
      return NextResponse.json({ error: "Members cannot change the household name" }, { status: 403 });
    }

    const rawMembers = body.householdMembers;
    if (rawMembers !== undefined && !Array.isArray(rawMembers)) {
      return badRequestResponse("householdMembers must be an array");
    }
    if (Array.isArray(rawMembers) && rawMembers.length > 1) {
      return NextResponse.json(
        { error: "Members can only edit their own household member record" },
        { status: 403 }
      );
    }

    let normalizedMember: ReturnType<typeof normalizeHouseholdMember> = null;
    if (Array.isArray(rawMembers) && rawMembers.length === 1) {
      try {
        normalizedMember = normalizeHouseholdMember(rawMembers[0]!);
      } catch (error) {
        return badRequestResponse(error instanceof Error ? error.message : "Invalid household member payload");
      }

      if (!normalizedMember) {
        return badRequestResponse("Each household member must include a name");
      }

      if (linkedMemberResult.data && normalizedMember.id && normalizedMember.id !== linkedMemberResult.data.id) {
        return NextResponse.json(
          { error: "Members can only edit their own household member record" },
          { status: 403 }
        );
      }
    }

    if (normalizedMember) {
      if (!linkedMemberResult.data) {
        return badRequestResponse("No linked household member record found for this account");
      }

      const updateLinkedMemberResult = await supabaseAdmin
        .from("household_members")
        .update({
          name: normalizedMember.name,
          date_of_birth: normalizedMember.dateOfBirth,
          likes: normalizedMember.likes,
          dislikes: normalizedMember.dislikes,
          avatar_url: normalizedMember.avatarUrl,
        })
        .eq("id", linkedMemberResult.data.id)
        .eq("profile_id", organizerId)
        .eq("linked_profile_id", userId);

      if (updateLinkedMemberResult.error) {
        return serverError(
          "PUT /api/me member update failed",
          "Failed to save profile",
          updateLinkedMemberResult.error
        );
      }
    }

    if (body.dietaryRestrictions !== undefined) {
      let normalizedRestrictions: DietaryRestrictionInput[];
      try {
        normalizedRestrictions = normalizeDietaryRestrictions(body.dietaryRestrictions);
      } catch (error) {
        return badRequestResponse(error instanceof Error ? error.message : "Invalid dietary restrictions");
      }

      // Restrictions are stored under the organizer's profile (matching where GET reads them).
      // Only delete/replace the specific member-key types being submitted so we don't
      // touch other household members' restrictions.
      const updatedTypes = [...new Set(normalizedRestrictions.map((r) => r.type))];

      if (updatedTypes.length > 0) {
        const deleteRestrictionsResult = await supabaseAdmin
          .from("dietary_restrictions")
          .delete()
          .eq("profile_id", organizerId)
          .in("type", updatedTypes);

        if (deleteRestrictionsResult.error) {
          return serverError(
            "PUT /api/me member delete restrictions failed",
            "Failed to save profile",
            deleteRestrictionsResult.error
          );
        }
      }

      if (normalizedRestrictions.length > 0) {
        const insertRestrictionsResult = await supabaseAdmin.from("dietary_restrictions").insert(
          normalizedRestrictions.map((restriction) => ({
            profile_id: organizerId,
            type: restriction.type,
            value: restriction.value,
          }))
        );

        if (insertRestrictionsResult.error) {
          return serverError(
            "PUT /api/me member insert restrictions failed",
            "Failed to save profile",
            insertRestrictionsResult.error
          );
        }
      }
    }

    return NextResponse.json({ ok: true });
  }

  let normalizedPayload: ReturnType<typeof normalizePayload>;
  try {
    normalizedPayload = normalizePayload(body);
  } catch (error) {
    return badRequestResponse(error instanceof Error ? error.message : "Invalid request body");
  }

  const upsertProfileResult = await supabaseAdmin.from("profiles").upsert(
    {
      id: userId,
      household_name: normalizedPayload.householdName,
      avatar_url: normalizedPayload.avatarUrl,
    },
    { onConflict: "id" }
  );

  if (upsertProfileResult.error) {
    return serverError("PUT /api/me upsert profile failed", "Failed to save profile", upsertProfileResult.error);
  }

  const [existingManualMembersResult, existingLinkedMembersResult] = await Promise.all([
    supabaseAdmin
      .from("household_members")
      .select("id")
      .eq("profile_id", userId)
      .is("linked_profile_id", null),
    supabaseAdmin
      .from("household_members")
      .select("id")
      .eq("profile_id", userId)
      .not("linked_profile_id", "is", null),
  ]);

  if (existingManualMembersResult.error || existingLinkedMembersResult.error) {
    return serverError(
      "PUT /api/me existing members lookup failed",
      "Failed to save profile",
      existingManualMembersResult.error ?? existingLinkedMembersResult.error
    );
  }

  const existingManualMemberIds = new Set((existingManualMembersResult.data ?? []).map((member) => member.id));
  const existingLinkedMemberIds = new Set((existingLinkedMembersResult.data ?? []).map((member) => member.id));
  const updateMemberIds = new Set<string>();

  let membersToUpsert: Array<{
    id?: string;
    profile_id: string;
    name: string;
    date_of_birth: string | null;
    likes: string[];
    dislikes: string[];
    avatar_url: string | null;
    sort_order: number;
  }>;

  try {
    for (const member of normalizedPayload.householdMembers) {
      if (member.id && existingLinkedMemberIds.has(member.id)) {
        return NextResponse.json(
          { error: "You cannot edit another user's profile" },
          { status: 403 }
        );
      }
    }

    membersToUpsert = normalizedPayload.householdMembers.map((member, index) => {
      if (member.id) {
        if (!existingManualMemberIds.has(member.id)) {
          throw new Error("Invalid household member id in request");
        }
        updateMemberIds.add(member.id);
      }

      return {
        ...(member.id ? { id: member.id } : {}),
        profile_id: userId,
        name: member.name,
        date_of_birth: member.dateOfBirth ?? null,
        likes: member.likes ?? [],
        dislikes: member.dislikes ?? [],
        avatar_url: member.avatarUrl ?? null,
        sort_order: index,
      };
    });
  } catch (error) {
    return badRequestResponse(error instanceof Error ? error.message : "Invalid household member payload");
  }

  if (membersToUpsert.length > 0) {
    const upsertMembersResult = await supabaseAdmin
      .from("household_members")
      .upsert(membersToUpsert, { onConflict: "id" });

    if (upsertMembersResult.error) {
      return serverError(
        "PUT /api/me upsert members failed",
        "Failed to save profile",
        upsertMembersResult.error
      );
    }
  }

  const staleMemberIds = Array.from(existingManualMemberIds).filter((id) => !updateMemberIds.has(id));
  if (staleMemberIds.length > 0) {
    const deleteStaleMembersResult = await supabaseAdmin
      .from("household_members")
      .delete()
      .eq("profile_id", userId)
      .is("linked_profile_id", null)
      .in("id", staleMemberIds);

    if (deleteStaleMembersResult.error) {
      return serverError(
        "PUT /api/me delete stale members failed",
        "Failed to save profile",
        deleteStaleMembersResult.error
      );
    }
  }

  const deleteRestrictionsResult = await supabaseAdmin
    .from("dietary_restrictions")
    .delete()
    .eq("profile_id", userId);
  if (deleteRestrictionsResult.error) {
    return serverError(
      "PUT /api/me delete restrictions failed",
      "Failed to save profile",
      deleteRestrictionsResult.error
    );
  }

  if (normalizedPayload.dietaryRestrictions.length > 0) {
    const insertRestrictionsResult = await supabaseAdmin.from("dietary_restrictions").insert(
      normalizedPayload.dietaryRestrictions.map((restriction) => ({
        profile_id: userId,
        type: restriction.type,
        value: restriction.value,
      }))
    );

    if (insertRestrictionsResult.error) {
      return serverError(
        "PUT /api/me insert restrictions failed",
        "Failed to save profile",
        insertRestrictionsResult.error
      );
    }
  }

  const updatedProfileResult = await getProfileRow(userId);

  if (updatedProfileResult.error) {
    return serverError(
      "PUT /api/me updated profile lookup failed",
      "Failed to save profile",
      updatedProfileResult.error
    );
  }

  return NextResponse.json({
    profile: updatedProfileResult.data ?? {
      id: userId,
      household_name: normalizedPayload.householdName,
      avatar_url: normalizedPayload.avatarUrl,
      created_at: new Date().toISOString(),
      social_profile_visible: true,
    },
    householdMembers: normalizedPayload.householdMembers.map((member) => ({
      id: member.id,
      name: member.name,
      date_of_birth: member.dateOfBirth,
      likes: member.likes,
      dislikes: member.dislikes,
      avatar_url: member.avatarUrl,
    })),
    dietaryRestrictions: normalizedPayload.dietaryRestrictions,
  });
}

export async function DELETE(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  // The same deletion as DELETE /v1/me (services/account-deletion), so a BigTable account deletion
  // also removes the person's Hearken data and Plaid connections. The RevenueCat customer is
  // deleted only for a paid BigTable tier, as before.
  let result;
  try {
    result = await deleteHearthAccount(userId, { revenueCat: "paid-tier" });
  } catch (error) {
    if (error instanceof AccountDeletionError) {
      return serverError(`DELETE /api/me ${error.step} failed`, error.message, error.failure);
    }
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return serverError("DELETE /api/me failed", "Failed to delete account", error);
  }

  if (result === "household_has_members") {
    return conflictResponse("Remove all household members before deleting your account");
  }

  return NextResponse.json({ ok: true });
}

export async function PATCH(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return unauthorizedResponse();
  }

  let body: MePatchPayload;
  try {
    body = (await request.json()) as MePatchPayload;
  } catch {
    return badRequestResponse("Request body must be valid JSON");
  }

  if (body.tutorialComplete !== undefined) {
    if (typeof body.tutorialComplete !== "boolean") {
      return badRequestResponse("tutorialComplete must be a boolean");
    }

    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ tutorial_complete: body.tutorialComplete })
      .eq("id", userId);

    if (error) {
      return serverError("PATCH /api/me tutorial_complete failed", "Failed to update profile", error);
    }
  }

  return NextResponse.json({ ok: true });
}
