import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { insertNotification } from "../lib/notifications.js";
import { getUsageStatus } from "../lib/rate-limit.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../lib/supabase.js";

type PermissionsBody = {
  canManageMealPlan?: boolean;
  canUseAiMealPlan?: boolean;
  canUseAiGrocery?: boolean;
  canEditMembers?: boolean;
};

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

export async function GET(request: Request, context: { params: Promise<{ memberId: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { memberId } = await context.params;
  const targetMemberId = memberId.trim();
  if (!targetMemberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  // Verify caller is the organizer of this member's household.
  const membershipResult = await supabaseAdmin
    .from("household_memberships")
    .select("organizer_id")
    .eq("member_id", targetMemberId)
    .maybeSingle();

  if (membershipResult.error) {
    return serverError("GET /api/household/members/[memberId]/permissions membership lookup failed", "Failed to load permissions", membershipResult.error);
  }

  if (!membershipResult.data) {
    return NextResponse.json({ error: "Membership not found" }, { status: 404 });
  }

  // Allow the member to read their own permissions row, not just the organizer.
  if (membershipResult.data.organizer_id !== userId && targetMemberId !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const permissionsResult = await supabaseAdmin
    .from("household_member_permissions")
    .select("can_manage_meal_plan, can_use_ai_meal_plan, can_use_ai_grocery, can_edit_members")
    .eq("member_id", targetMemberId)
    .maybeSingle();

  if (permissionsResult.error) {
    return serverError("GET /api/household/members/[memberId]/permissions fetch failed", "Failed to load permissions", permissionsResult.error);
  }

  // Return all-false defaults if no row exists yet (pre-backfill safety).
  const row = permissionsResult.data ?? {
    can_manage_meal_plan: false,
    can_use_ai_meal_plan: false,
    can_use_ai_grocery: false,
    can_edit_members: false,
  };

  return NextResponse.json({
    canManageMealPlan: row.can_manage_meal_plan,
    canUseAiMealPlan: row.can_use_ai_meal_plan,
    canUseAiGrocery: row.can_use_ai_grocery,
    canEditMembers: row.can_edit_members,
  });
}

export async function PATCH(request: Request, context: { params: Promise<{ memberId: string }> }) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { memberId } = await context.params;
  const targetMemberId = memberId.trim();
  if (!targetMemberId) {
    return NextResponse.json({ error: "Invalid member id" }, { status: 400 });
  }

  // Verify caller is the organizer of this member's household.
  const membershipResult = await supabaseAdmin
    .from("household_memberships")
    .select("organizer_id")
    .eq("member_id", targetMemberId)
    .maybeSingle();

  if (membershipResult.error) {
    return serverError("PATCH /api/household/members/[memberId]/permissions membership lookup failed", "Failed to update permissions", membershipResult.error);
  }

  if (!membershipResult.data) {
    return NextResponse.json({ error: "Membership not found" }, { status: 404 });
  }

  if (membershipResult.data.organizer_id !== userId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: PermissionsBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { canManageMealPlan, canUseAiMealPlan, canUseAiGrocery, canEditMembers } = body;

  // Validate that AI permissions are only enabled when the organizer has Pro.
  const wantsAiEnabled = (isBoolean(canUseAiMealPlan) && canUseAiMealPlan)
    || (isBoolean(canUseAiGrocery) && canUseAiGrocery);

  if (wantsAiEnabled) {
    const { tier } = await getUsageStatus(userId);
    if (tier !== "pro") {
      return NextResponse.json({ error: "A Pro subscription is required to grant AI access" }, { status: 403 });
    }
  }

  const update: Record<string, boolean | string> = { updated_at: new Date().toISOString() };
  if (isBoolean(canManageMealPlan)) update.can_manage_meal_plan = canManageMealPlan;
  if (isBoolean(canUseAiMealPlan)) update.can_use_ai_meal_plan = canUseAiMealPlan;
  if (isBoolean(canUseAiGrocery)) update.can_use_ai_grocery = canUseAiGrocery;
  if (isBoolean(canEditMembers)) update.can_edit_members = canEditMembers;

  const upsertResult = await supabaseAdmin
    .from("household_member_permissions")
    .upsert({ member_id: targetMemberId, ...update }, { onConflict: "member_id" });

  if (upsertResult.error) {
    return serverError("PATCH /api/household/members/[memberId]/permissions upsert failed", "Failed to update permissions", upsertResult.error);
  }

  await insertNotification({
    recipientProfileId: targetMemberId,
    type: "household_member_permissions_changed",
    actorProfileId: userId,
  });

  return NextResponse.json({ ok: true });
}
