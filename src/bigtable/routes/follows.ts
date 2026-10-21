import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { notifyNewFollower } from "../lib/notifications.js";
import { loadAllPublicDisplayNames, loadPublicDisplayNames } from "../lib/public-identity.js";
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
  const mode = (url.searchParams.get("mode") ?? "following").toLowerCase();
  const limitParam = Number(url.searchParams.get("limit") ?? "30");
  const offsetParam = Number(url.searchParams.get("offset") ?? "0");

  if (mode !== "following" && mode !== "followers" && mode !== "discover") {
    return badRequest("mode must be following, followers, or discover");
  }

  const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(100, Math.trunc(limitParam))) : 30;
  const offset = Number.isFinite(offsetParam) ? Math.max(0, Math.trunc(offsetParam)) : 0;

  if (mode === "discover") {
    const [profilesLookup, organizerLookup, followsLookup, publishedRecipesLookup, currentFollowingLookup, blocksLookup] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, household_name, avatar_url, created_at, social_profile_visible")
        .eq("social_profile_visible", true),
      supabaseAdmin
        .from("household_members")
        .select("profile_id, linked_profile_id, name, avatar_url, sort_order")
        .order("sort_order", { ascending: true }),
      supabaseAdmin
        .from("follows")
        .select("follower_profile_id, followee_profile_id"),
      supabaseAdmin
        .from("recipes")
        .select("created_by_profile_id")
        .eq("status", "published"),
      supabaseAdmin
        .from("follows")
        .select("followee_profile_id")
        .eq("follower_profile_id", userId),
      supabaseAdmin
        .from("blocks")
        .select("blocker_id, blocked_id")
        .or(`blocker_id.eq.${userId},blocked_id.eq.${userId}`),
    ]);

    const { data: profiles, error: profilesError } = profilesLookup;
    const { data: organizers, error: organizerError } = organizerLookup;
    const { data: followRows, error: followsError } = followsLookup;
    const { data: publishedRows, error: publishedError } = publishedRecipesLookup;
    const { data: currentFollowingRows, error: currentFollowingError } = currentFollowingLookup;
    const { data: blockRows, error: blocksError } = blocksLookup;

    if (profilesError) {
      return serverError("GET /api/follows discover profile lookup failed", "Failed to fetch follows", profilesError);
    }

    if (organizerError) {
      return serverError("GET /api/follows discover organizer lookup failed", "Failed to fetch follows", organizerError);
    }

    if (followsError) {
      return serverError("GET /api/follows discover follows lookup failed", "Failed to fetch follows", followsError);
    }

    if (publishedError) {
      return serverError("GET /api/follows discover recipes lookup failed", "Failed to fetch follows", publishedError);
    }

    if (currentFollowingError) {
      return serverError("GET /api/follows discover current-following lookup failed", "Failed to fetch follows", currentFollowingError);
    }

    if (blocksError) {
      return serverError("GET /api/follows discover blocks lookup failed", "Failed to fetch follows", blocksError);
    }

    const displayNames = await loadAllPublicDisplayNames();
    const organizerByProfileId = (organizers ?? []).reduce<Record<string, { name: string | null; avatarUrl: string | null }>>(
      (acc, member) => {
        const profileId = typeof member.profile_id === "string" ? member.profile_id : "";
        const linkedProfileId = typeof member.linked_profile_id === "string" ? member.linked_profile_id : "";
        const name = typeof member.name === "string" ? member.name : null;
        const avatarUrl = typeof member.avatar_url === "string" ? member.avatar_url : null;

        if (linkedProfileId && !acc[linkedProfileId]) {
          acc[linkedProfileId] = { name, avatarUrl };
        }

        if (profileId && !acc[profileId]) {
          acc[profileId] = { name, avatarUrl };
        }

        return acc;
      },
      {}
    );

    const followerCountByProfileId: Record<string, number> = {};
    const followingCountByProfileId: Record<string, number> = {};
    (followRows ?? []).forEach((row) => {
      const followerProfileId = typeof row.follower_profile_id === "string" ? row.follower_profile_id : "";
      const followeeProfileId = typeof row.followee_profile_id === "string" ? row.followee_profile_id : "";
      if (followeeProfileId) {
        followerCountByProfileId[followeeProfileId] = (followerCountByProfileId[followeeProfileId] ?? 0) + 1;
      }
      if (followerProfileId) {
        followingCountByProfileId[followerProfileId] = (followingCountByProfileId[followerProfileId] ?? 0) + 1;
      }
    });

    const publishedCountByProfileId: Record<string, number> = {};
    (publishedRows ?? []).forEach((row) => {
      const profileId = typeof row.created_by_profile_id === "string" ? row.created_by_profile_id : "";
      if (!profileId) {
        return;
      }
      publishedCountByProfileId[profileId] = (publishedCountByProfileId[profileId] ?? 0) + 1;
    });

    const currentlyFollowing = new Set(
      (currentFollowingRows ?? [])
        .map((row) => (typeof row.followee_profile_id === "string" ? row.followee_profile_id : ""))
        .filter(Boolean)
    );

    const blockedCallerBy = new Set<string>();
    (blockRows ?? []).forEach((row) => {
      const blockerId = typeof row.blocker_id === "string" ? row.blocker_id : "";
      const blockedId = typeof row.blocked_id === "string" ? row.blocked_id : "";
      if (blockedId === userId && blockerId) {
        blockedCallerBy.add(blockerId);
      }
    });

    const discoverProfiles = (profiles ?? [])
      .filter((profile) => {
        if (!profile?.id || profile.id === userId) {
          return false;
        }
        if (blockedCallerBy.has(profile.id)) {
          return false;
        }
        return true;
      })
      .map((profile) => {
        const organizer = organizerByProfileId[profile.id];
        const followerCount = followerCountByProfileId[profile.id] ?? 0;
        const followingCount = followingCountByProfileId[profile.id] ?? 0;
        const publishedRecipeCount = publishedCountByProfileId[profile.id] ?? 0;
        const profileNameRaw = displayNames.get(profile.id) ?? organizer?.name ?? profile.household_name ?? null;
        const profileName = typeof profileNameRaw === "string" ? profileNameRaw.trim() : "";
        if (!profileName) {
          return null;
        }
        const avatarUrl = organizer?.avatarUrl ?? profile.avatar_url ?? null;
        return {
          profileId: profile.id,
          followedAt: typeof profile.created_at === "string" ? profile.created_at : "",
          joinedAt: typeof profile.created_at === "string" ? profile.created_at : null,
          profileName,
          avatarUrl: toMemberAvatarPublicUrl(avatarUrl),
          isFollowing: currentlyFollowing.has(profile.id),
          followerCount,
          followingCount,
          publishedRecipeCount,
        };
      })
      .filter((profile): profile is NonNullable<typeof profile> => Boolean(profile))
      .sort((a, b) => {
        if (b.followerCount !== a.followerCount) {
          return b.followerCount - a.followerCount;
        }
        if (b.publishedRecipeCount !== a.publishedRecipeCount) {
          return b.publishedRecipeCount - a.publishedRecipeCount;
        }
        return (a.profileName ?? "").localeCompare(b.profileName ?? "");
      });

    const totalCount = discoverProfiles.length;
    const paginated = discoverProfiles.slice(offset, offset + limit);
    const hasMore = offset + paginated.length < totalCount;

    return NextResponse.json({
      mode,
      profiles: paginated,
      pagination: {
        limit,
        offset,
        totalCount,
        hasMore,
        nextOffset: hasMore ? offset + paginated.length : null,
      },
    });
  }

  const isFollowingMode = mode === "following";
  const selectColumn = isFollowingMode ? "followee_profile_id" : "follower_profile_id";
  const filterColumn = isFollowingMode ? "follower_profile_id" : "followee_profile_id";

  const { data, error, count } = await supabaseAdmin
    .from("follows")
    .select(`${selectColumn}, created_at`, { count: "exact" })
    .eq(filterColumn, userId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return serverError("GET /api/follows failed", "Failed to fetch follows", error);
  }

  const rows = data ?? [];
  const totalCount = typeof count === "number" ? count : null;
  const hasMore = totalCount !== null ? offset + rows.length < totalCount : rows.length === limit;

  const profileIds = Array.from(
    new Set(
      rows
        .map((row) => {
          const record = row as Record<string, unknown>;
          return typeof record[selectColumn] === "string" ? record[selectColumn].trim() : "";
        })
        .filter(Boolean)
    )
  );

  let profileById: Record<string, { profileName: string | null; avatarUrl: string | null }> = {};
  let currentlyFollowingByProfileId: Record<string, boolean> = {};
  if (profileIds.length > 0) {
    const [profileLookup, organizerLookup, currentFollowingLookup] = await Promise.all([
      supabaseAdmin
        .from("profiles")
        .select("id, household_name, avatar_url")
        .in("id", profileIds),
      supabaseAdmin
        .from("household_members")
        .select("profile_id, name, avatar_url, sort_order")
        .in("profile_id", profileIds)
        .order("sort_order", { ascending: true }),
      supabaseAdmin
        .from("follows")
        .select("followee_profile_id")
        .eq("follower_profile_id", userId)
        .in("followee_profile_id", profileIds),
    ]);

    const { data: profileRows, error: profileError } = profileLookup;
    const { data: organizerRows, error: organizerError } = organizerLookup;
    const { data: currentFollowingRows, error: currentFollowingError } = currentFollowingLookup;

    if (profileError) {
      return serverError("GET /api/follows profile lookup failed", "Failed to fetch follows", profileError);
    }

    if (organizerError) {
      return serverError("GET /api/follows organizer lookup failed", "Failed to fetch follows", organizerError);
    }

    if (currentFollowingError) {
      return serverError("GET /api/follows current-following lookup failed", "Failed to fetch follows", currentFollowingError);
    }

    const displayNames = await loadPublicDisplayNames(profileIds);
    const organizerByProfileId = (organizerRows ?? []).reduce<
      Record<string, { name: string | null; avatarUrl: string | null }>
    >((acc, member) => {
      const profileId = typeof member.profile_id === "string" ? member.profile_id : "";
      if (!profileId || acc[profileId]) {
        return acc;
      }
      acc[profileId] = {
        name: typeof member.name === "string" ? member.name : null,
        avatarUrl: typeof member.avatar_url === "string" ? member.avatar_url : null,
      };
      return acc;
    }, {});

    profileById = (profileRows ?? []).reduce<Record<string, { profileName: string | null; avatarUrl: string | null }>>(
      (acc, profile) => {
        if (!profile?.id) {
          return acc;
        }
        const organizer = organizerByProfileId[profile.id];
        acc[profile.id] = {
          profileName: displayNames.get(profile.id) ?? organizer?.name ?? profile.household_name ?? null,
          avatarUrl: organizer?.avatarUrl ?? profile.avatar_url ?? null,
        };
        return acc;
      },
      {}
    );

    currentlyFollowingByProfileId = (currentFollowingRows ?? []).reduce<Record<string, boolean>>((acc, row) => {
      const profileId = typeof row.followee_profile_id === "string" ? row.followee_profile_id : "";
      if (profileId) {
        acc[profileId] = true;
      }
      return acc;
    }, {});
  }

  return NextResponse.json({
    mode,
    profiles: rows.map((row) => {
      const record = row as Record<string, unknown>;
      const profileId = typeof record[selectColumn] === "string" ? record[selectColumn] : "";
      const followedAt = typeof record.created_at === "string" ? record.created_at : "";
      const profileMeta = profileById[profileId] ?? { profileName: null, avatarUrl: null };
      return {
        profileId,
        followedAt,
        profileName: profileMeta.profileName,
        avatarUrl: toMemberAvatarPublicUrl(profileMeta.avatarUrl),
        isFollowing: isFollowingMode ? true : Boolean(currentlyFollowingByProfileId[profileId]),
      };
    }),
    pagination: {
      limit,
      offset,
      totalCount,
      hasMore,
      nextOffset: hasMore ? offset + rows.length : null,
    },
  });
}

export async function PUT(request: Request) {
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

  const followeeProfileId = payload.followeeProfileId;
  const following = payload.following;

  if (typeof followeeProfileId !== "string" || !followeeProfileId.trim()) {
    return badRequest("followeeProfileId is required");
  }
  if (typeof following !== "boolean") {
    return badRequest("following must be a boolean");
  }
  if (followeeProfileId === userId) {
    return badRequest("Cannot follow yourself");
  }

  if (following) {
    const { data: existing, error: existingError } = await supabaseAdmin
      .from("follows")
      .select("follower_profile_id")
      .eq("follower_profile_id", userId)
      .eq("followee_profile_id", followeeProfileId)
      .maybeSingle();

    if (existingError) {
      return serverError("PUT /api/follows existing lookup failed", "Failed to update follow", existingError);
    }

    const { error } = await supabaseAdmin
      .from("follows")
      .upsert({
        follower_profile_id: userId,
        followee_profile_id: followeeProfileId,
      });

    if (error) {
      return serverError("PUT /api/follows follow failed", "Failed to update follow", error);
    }

    if (!existing) {
      await notifyNewFollower({
        actorProfileId: userId,
        recipientProfileId: followeeProfileId,
      });
    }
  } else {
    const { error } = await supabaseAdmin
      .from("follows")
      .delete()
      .eq("follower_profile_id", userId)
      .eq("followee_profile_id", followeeProfileId);

    if (error) {
      return serverError("PUT /api/follows unfollow failed", "Failed to update follow", error);
    }
  }

  return NextResponse.json({ ok: true });
}
