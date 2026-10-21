import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

// The Hearth household (in iCloud) is the one list of who's in a family, and each person's role
// there decides what they can do with the organizer's plan: parents everything, adults the meal
// plan and AI, kids neither. The organizer's Hearth app sends here each person who has linked a
// Hearth account, with their role, whenever the household changes; members' permissions follow.
// People join the membership themselves (POST /household/join, with the household's join code)
// and leave or are removed through DELETE /household/members/{memberId}; this never adds or
// removes anyone, so a kid (whose app can't write to the household) keeps the family's plan.

export type Role = "parent" | "adult" | "kid";

type Permissions = {
  can_manage_meal_plan: boolean;
  can_use_ai_meal_plan: boolean;
  can_use_ai_grocery: boolean;
  can_edit_members: boolean;
};

const MAX_PEOPLE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a household role can do with the organizer's plan. */
export function permissionsFor(role: Role): Permissions {
  switch (role) {
    case "parent":
      return { can_manage_meal_plan: true, can_use_ai_meal_plan: true, can_use_ai_grocery: true, can_edit_members: true };
    case "adult":
      return { can_manage_meal_plan: true, can_use_ai_meal_plan: true, can_use_ai_grocery: true, can_edit_members: false };
    case "kid":
      return { can_manage_meal_plan: false, can_use_ai_meal_plan: false, can_use_ai_grocery: false, can_edit_members: false };
  }
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/** The household's people with accounts, from the body; null when it's malformed. */
function parsePeople(body: unknown): Map<string, Role> | null {
  if (typeof body !== "object" || body === null || !Array.isArray((body as { members?: unknown }).members)) return null;
  const list = (body as { members: unknown[] }).members;
  if (list.length > MAX_PEOPLE) return null;
  const people = new Map<string, Role>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) return null;
    const accountId = (entry as { accountId?: unknown }).accountId;
    const role = (entry as { role?: unknown }).role;
    if (typeof accountId !== "string" || !UUID.test(accountId)) return null;
    if (role !== "parent" && role !== "adult" && role !== "kid") return null;
    people.set(accountId.toLowerCase(), role);
  }
  return people;
}

export async function PUT(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON");
  }
  const people = parsePeople(body);
  if (!people) {
    return badRequest(`members must be a list of up to ${MAX_PEOPLE} { accountId, role } (role: parent, adult or kid)`);
  }

  const [ownMembership, memberships] = await Promise.all([
    supabaseAdmin.from("household_memberships").select("organizer_id").eq("member_id", userId).maybeSingle(),
    supabaseAdmin.from("household_memberships").select("member_id").eq("organizer_id", userId),
  ]);
  const lookupError = ownMembership.error ?? memberships.error;
  if (lookupError) {
    return serverError("PUT /household/members lookup failed", "Failed to update the household", lookupError);
  }
  if (ownMembership.data) {
    return NextResponse.json({ error: "Only the household's organizer can do this" }, { status: 403 });
  }

  const updated: string[] = [];
  for (const { member_id: memberId } of (memberships.data ?? []) as Array<{ member_id: string }>) {
    const role = people.get(memberId.toLowerCase());
    if (!role || memberId === userId) continue;
    const permissions = await supabaseAdmin
      .from("household_member_permissions")
      .upsert({ member_id: memberId, ...permissionsFor(role), updated_at: new Date().toISOString() }, { onConflict: "member_id" });
    if (permissions.error) {
      return serverError("PUT /household/members permissions failed", "Failed to update the household", permissions.error);
    }
    updated.push(memberId);
  }

  // Who has joined with the code; the rest join when their app redeems it.
  return NextResponse.json({ joined: updated });
}
