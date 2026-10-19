import { supabaseAdmin } from "./supabase.js";

export const MAX_DISPLAY_NAME_LENGTH = 60;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The public display names (`profiles.display_name`) for these profiles, keyed by profile id.
 * Profiles without one are left out. Best effort: when the column isn't there yet (migration not
 * applied) or the lookup fails, the map is empty and callers fall back to the household-member
 * name, exactly as before.
 */
export async function loadPublicDisplayNames(profileIds: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(profileIds.filter((id) => typeof id === "string" && id.trim().length > 0)));
  const names = new Map<string, string>();
  if (ids.length === 0) {
    return names;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name")
      .in("id", ids);

    if (error || !Array.isArray(data)) {
      return names;
    }

    for (const row of data as Array<{ id?: unknown; display_name?: unknown }>) {
      const name = cleanName(row.display_name);
      if (typeof row.id === "string" && name) {
        names.set(row.id, name);
      }
    }
  } catch {
    return names;
  }

  return names;
}

/**
 * Every profile that has a public display name. For lists that already span all visible profiles
 * (follow discovery), where an id filter would be as big as the table. Same best-effort rules.
 */
export async function loadAllPublicDisplayNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, display_name")
      .not("display_name", "is", null);

    if (error || !Array.isArray(data)) {
      return names;
    }

    for (const row of data as Array<{ id?: unknown; display_name?: unknown }>) {
      const name = cleanName(row.display_name);
      if (typeof row.id === "string" && name) {
        names.set(row.id, name);
      }
    }
  } catch {
    return names;
  }
  return names;
}

/** The public name for one profile, or null. Same best-effort rules as `loadPublicDisplayNames`. */
export async function loadPublicDisplayName(profileId: string): Promise<string | null> {
  const names = await loadPublicDisplayNames([profileId]);
  return names.get(profileId) ?? null;
}

/**
 * Normalizes a requested display name: trimmed, empty means none, too long is an error.
 * Throws with a client-facing message.
 */
export function normalizeDisplayName(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("displayName must be a string or null");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > MAX_DISPLAY_NAME_LENGTH) {
    throw new Error(`displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or fewer`);
  }
  return trimmed;
}
