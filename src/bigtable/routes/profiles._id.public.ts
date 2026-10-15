import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { toMemberAvatarPublicUrl } from "../lib/member-avatar.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const profileId = id.trim();
  if (!profileId) {
    return NextResponse.json({ error: "Invalid profile id" }, { status: 400 });
  }

  const targetBlockedCallerResult = await supabaseAdmin
    .from("blocks")
    .select("blocker_id")
    .eq("blocker_id", profileId)
    .eq("blocked_id", userId)
    .maybeSingle();

  if (targetBlockedCallerResult.error) {
    return serverError(
      "GET /api/profiles/[id]/public blocks lookup failed",
      "Failed to fetch profile",
      targetBlockedCallerResult.error
    );
  }

  if (targetBlockedCallerResult.data) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from("profiles")
    .select("id, household_name, avatar_url, created_at, social_profile_visible")
    .eq("id", profileId)
    .maybeSingle();

  if (profileError) {
    return serverError("GET /api/profiles/[id]/public profile lookup failed", "Failed to fetch profile", profileError);
  }

  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const [callerMembershipResult, targetMembershipResult] = await Promise.all([
    supabaseAdmin
      .from("household_memberships")
      .select("organizer_id")
      .eq("member_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("household_memberships")
      .select("organizer_id")
      .eq("member_id", profileId)
      .maybeSingle(),
  ]);

  if (callerMembershipResult.error || targetMembershipResult.error) {
    return serverError(
      "GET /api/profiles/[id]/public household membership lookup failed",
      "Failed to fetch profile",
      callerMembershipResult.error ?? targetMembershipResult.error
    );
  }

  const callerOrganizerId = callerMembershipResult.data?.organizer_id ?? userId;
  const targetOrganizerId = targetMembershipResult.data?.organizer_id ?? profileId;
  const inSameHousehold = callerOrganizerId === targetOrganizerId;

  if (profile.id !== userId && profile.social_profile_visible === false && !inSameHousehold) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  const [linkedMemberLookup, ownMemberLookup] = await Promise.all([
    supabaseAdmin
      .from("household_members")
      .select("name, avatar_url")
      .eq("linked_profile_id", profileId)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from("household_members")
      .select("name, avatar_url")
      .eq("profile_id", profileId)
      .order("sort_order", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  if (linkedMemberLookup.error || ownMemberLookup.error) {
    return serverError(
      "GET /api/profiles/[id]/public organizer lookup failed",
      "Failed to fetch profile",
      linkedMemberLookup.error ?? ownMemberLookup.error
    );
  }

  const organizerMember = linkedMemberLookup.data ?? ownMemberLookup.data;

  const [followersCountResult, followingCountResult] = await Promise.all([
    supabaseAdmin
      .from("follows")
      .select("follower_profile_id", { count: "exact", head: true })
      .eq("followee_profile_id", profileId),
    supabaseAdmin
      .from("follows")
      .select("followee_profile_id", { count: "exact", head: true })
      .eq("follower_profile_id", profileId),
  ]);

  if (followersCountResult.error) {
    return serverError(
      "GET /api/profiles/[id]/public followers count lookup failed",
      "Failed to fetch profile",
      followersCountResult.error
    );
  }

  if (followingCountResult.error) {
    return serverError(
      "GET /api/profiles/[id]/public following count lookup failed",
      "Failed to fetch profile",
      followingCountResult.error
    );
  }

  const followerCount = Math.max(0, followersCountResult.count ?? 0);
  const followingCount = Math.max(0, followingCountResult.count ?? 0);

  const { data: recipes, error: recipesError } = await supabaseAdmin
    .from("recipes")
    .select("id, title, description, image_url, published_at, like_count")
    .eq("created_by_profile_id", profileId)
    .eq("status", "published")
    .order("published_at", { ascending: false, nullsFirst: false })
    .order("title", { ascending: true });

  if (recipesError) {
    return serverError("GET /api/profiles/[id]/public recipes lookup failed", "Failed to fetch profile", recipesError);
  }

  return NextResponse.json({
    profile: {
      profileId: profile.id,
      profileName: organizerMember?.name ?? profile.household_name,
      avatarUrl: toMemberAvatarPublicUrl(organizerMember?.avatar_url ?? profile.avatar_url),
      joinedAt: profile.created_at,
      followerCount,
      followingCount,
    },
    recipes: (recipes ?? []).map((recipe) => ({
      id: recipe.id,
      title: recipe.title,
      description: recipe.description,
      imageUrl: recipe.image_url,
      publishedAt: recipe.published_at,
      likeCount: recipe.like_count ?? 0,
    })),
  });
}
