import { NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { serverError } from "../lib/server-error.js";
import { supabaseAdmin } from "../../services/supabase.js";

type JsonObject = Record<string, unknown>;

const ALLOWED_PREF_KEYS = [
  "recipe_published",
  "recipe_updated",
  "recipe_liked",
  "recipe_saved",
  "new_follower",
] as const;

type AllowedPrefKey = (typeof ALLOWED_PREF_KEYS)[number];

type NotificationPrefs = Partial<Record<AllowedPrefKey, boolean>>;

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function normalizePrefs(value: unknown): NotificationPrefs {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("notificationPrefs must be an object");
  }

  const payload = value as JsonObject;
  const normalized: NotificationPrefs = {};

  for (const key of ALLOWED_PREF_KEYS) {
    if (!(key in payload)) {
      continue;
    }
    const entry = payload[key];
    if (typeof entry !== "boolean") {
      throw new Error(`notificationPrefs.${key} must be a boolean`);
    }
    normalized[key] = entry;
  }

  return normalized;
}

export async function GET(request: Request) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("notification_prefs")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    return serverError("GET /api/me/notification-prefs failed", "Failed to fetch notification prefs", error);
  }

  return NextResponse.json({ notificationPrefs: data?.notification_prefs ?? {} });
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

  let normalizedPrefs: NotificationPrefs;
  try {
    normalizedPrefs = normalizePrefs(payload.notificationPrefs);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid notification prefs");
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("profiles")
    .select("notification_prefs")
    .eq("id", userId)
    .maybeSingle();

  if (existingError) {
    return serverError("PUT /api/me/notification-prefs existing prefs failed", "Failed to update notification prefs", existingError);
  }

  const mergedPrefs = {
    ...(typeof existing?.notification_prefs === "object" && existing.notification_prefs !== null ? existing.notification_prefs : {}),
    ...normalizedPrefs,
  };

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert({
      id: userId,
      notification_prefs: mergedPrefs,
    }, { onConflict: "id" });

  if (error) {
    return serverError("PUT /api/me/notification-prefs failed", "Failed to update notification prefs", error);
  }

  return NextResponse.json({ ok: true, notificationPrefs: mergedPrefs });
}
