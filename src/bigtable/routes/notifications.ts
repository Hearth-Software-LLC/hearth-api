import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { loadPublicDisplayNames } from "../lib/public-identity.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

type JsonObject = Record<string, unknown>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit") ?? "30");
  const offsetParam = Number(url.searchParams.get("offset") ?? "0");
  const unreadOnly = (url.searchParams.get("unreadOnly") ?? "false").toLowerCase() === "true";

  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, Math.trunc(limitParam))) : 30;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, Math.trunc(offsetParam)) : 0;

  let query = supabaseAdmin
    .from("notifications")
    .select("id, type, actor_profile_id, recipe_id, version_id, data, read_at, created_at", { count: "exact" })
    .eq("recipient_profile_id", userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (unreadOnly) {
    query = query.is("read_at", null);
  }

  const { data, error, count } = await query;
  if (error) {
    return serverError("GET /api/notifications failed", "Failed to fetch notifications", error);
  }

  // Filter out household_invitation notifications whose invitation is no longer pending
  // (e.g. organizer cancelled it). Extract invitation IDs from the data field.
  let notifications = data ?? [];
  const invitationNotifications = notifications.filter(
    (n) => n.type === "household_invitation" &&
      typeof (n.data as Record<string, unknown>)?.invitationId === "string",
  );

  if (invitationNotifications.length > 0) {
    const invitationIds = invitationNotifications.map(
      (n) => (n.data as Record<string, unknown>).invitationId as string,
    );
    const { data: invitations } = await supabaseAdmin
      .from("household_invitations")
      .select("id, status")
      .in("id", invitationIds);

    const pendingInvitationIds = new Set(
      (invitations ?? []).filter((inv) => inv.status === "pending").map((inv) => inv.id),
    );

    notifications = notifications.filter((n) => {
      if (n.type !== "household_invitation") return true;
      const invId = (n.data as Record<string, unknown>)?.invitationId;
      return typeof invId === "string" && pendingInvitationIds.has(invId);
    });
  }

  const actorProfileIds = Array.from(
    new Set(
      notifications
        .map((item) => item.actor_profile_id)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0),
    ),
  );

  let actorNameById: Record<string, string | null> = {};
  let actorAvatarById: Record<string, string | null> = {};
  if (actorProfileIds.length > 0) {
    const { data: actorProfiles } = await supabaseAdmin
      .from("profiles")
      .select("id, household_name, avatar_url")
      .in("id", actorProfileIds);

    const { data: actorMembers } = await supabaseAdmin
      .from("household_members")
      .select("profile_id, name, avatar_url, sort_order, linked_profile_id")
      .in("profile_id", actorProfileIds)
      .is("linked_profile_id", null)
      .order("sort_order", { ascending: true });

    const actorMemberNameById = (actorMembers ?? []).reduce<Record<string, string | null>>((acc, member) => {
      if (acc[member.profile_id] !== undefined) {
        return acc;
      }
      const memberName = typeof member.name === "string" ? member.name.trim() : "";
      acc[member.profile_id] = memberName.length > 0 ? memberName : null;
      return acc;
    }, {});

    const actorMemberAvatarById = (actorMembers ?? []).reduce<Record<string, string | null>>((acc, member) => {
      if (acc[member.profile_id] !== undefined) {
        return acc;
      }
      acc[member.profile_id] = toMemberAvatarPublicUrl(member.avatar_url ?? null);
      return acc;
    }, {});

    const actorDisplayNames = await loadPublicDisplayNames(actorProfileIds);
    actorNameById = (actorProfiles ?? []).reduce<Record<string, string | null>>((acc, profile) => {
      const profileHouseholdName = typeof profile.household_name === "string" ? profile.household_name.trim() : "";
      acc[profile.id] = actorDisplayNames.get(profile.id)
        ?? actorMemberNameById[profile.id]
        ?? (profileHouseholdName.length > 0 ? profileHouseholdName : null);
      return acc;
    }, {});

    actorAvatarById = (actorProfiles ?? []).reduce<Record<string, string | null>>((acc, profile) => {
      acc[profile.id] = actorMemberAvatarById[profile.id] ?? toMemberAvatarPublicUrl(profile.avatar_url ?? null);
      return acc;
    }, {});
  }

  return NextResponse.json({
    notifications: notifications.map((item) => ({
      id: item.id,
      type: item.type,
      actorProfileId: item.actor_profile_id,
      actorName: item.actor_profile_id ? actorNameById[item.actor_profile_id] ?? null : null,
      actorAvatarUrl: item.actor_profile_id ? actorAvatarById[item.actor_profile_id] ?? null : null,
      recipeId: item.recipe_id,
      versionId: item.version_id,
      data: item.data,
      readAt: item.read_at,
      createdAt: item.created_at,
    })),
    pagination: {
      limit,
      offset,
      totalCount: typeof count === "number" ? count : null,
    },
  });
}

export async function PATCH(request: Request) {
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

  const markAllRead = payload.markAllRead === true;
  const markUnread = payload.markUnread === true;
  const ids = Array.isArray(payload.ids)
    ? payload.ids.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];

  if (markAllRead && markUnread) {
    return badRequest("markAllRead and markUnread cannot both be true");
  }

  if (markUnread && ids.length === 0) {
    return badRequest("Provide ids when markUnread=true");
  }

  if (!markAllRead && ids.length === 0) {
    return badRequest("Provide ids or set markAllRead=true");
  }

  let query = supabaseAdmin
    .from("notifications")
    .update({ read_at: markUnread ? null : new Date().toISOString() })
    .eq("recipient_profile_id", userId);

  if (!markUnread) {
    query = query.is("read_at", null);
  }

  if (!markAllRead) {
    query = query.in("id", ids);
  }

  const { error } = await query;
  if (error) {
    return serverError("PATCH /api/notifications failed", "Failed to update notifications", error);
  }

  return NextResponse.json({ ok: true });
}
