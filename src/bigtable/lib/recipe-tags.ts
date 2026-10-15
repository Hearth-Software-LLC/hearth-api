export const MAX_CUSTOM_TAG_LENGTH = 30;

export type NormalizedTagLabel = {
  label: string;
  normalized: string;
};

// Validate and normalize a user-supplied custom tag label.
// `label` is the uppercased display form (tag names are case-insensitive and
// shown in all caps); `normalized` is the lowercased, whitespace-collapsed form
// stored on `recipes.tags` and used for matching.
// Throws on empty or over-long input so routes can return a 400.
export function normalizeCustomTagLabel(value: unknown): NormalizedTagLabel {
  if (typeof value !== "string") {
    throw new Error("label is required");
  }

  const cleaned = value.trim().replace(/\s+/g, " ");
  if (!cleaned) {
    throw new Error("label is required");
  }

  if (cleaned.length > MAX_CUSTOM_TAG_LENGTH) {
    throw new Error(`label must be ${MAX_CUSTOM_TAG_LENGTH} characters or fewer`);
  }

  return { label: cleaned.toUpperCase(), normalized: cleaned.toLowerCase() };
}
