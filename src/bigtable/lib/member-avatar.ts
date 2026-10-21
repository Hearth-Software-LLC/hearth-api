import { supabaseAdmin } from "../../services/supabase.js";

const MEMBER_AVATAR_STORAGE_PREFIX = "/storage/v1/object/public/member-avatars/";

function extractMemberAvatarObjectPath(avatarUrl: string): string | null {
  const trimmed = avatarUrl.trim();
  if (!trimmed) {
    return null;
  }

  const prefixIndex = trimmed.indexOf(MEMBER_AVATAR_STORAGE_PREFIX);
  if (prefixIndex >= 0) {
    const pathWithQuery = trimmed.slice(prefixIndex + MEMBER_AVATAR_STORAGE_PREFIX.length);
    const [rawObjectPath] = pathWithQuery.split("?");
    const objectPath = decodeURIComponent(rawObjectPath ?? "").trim();
    return objectPath || null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return null;
  }

  return trimmed;
}

export function toMemberAvatarPublicUrl(avatarUrl: string | null | undefined): string | null {
  if (typeof avatarUrl !== "string") {
    return null;
  }

  const trimmed = avatarUrl.trim();
  if (!trimmed) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const objectPath = extractMemberAvatarObjectPath(trimmed);
  if (!objectPath) {
    return null;
  }

  const { data } = supabaseAdmin.storage.from("member-avatars").getPublicUrl(objectPath);
  return data.publicUrl;
}
