// Weighted "recipe source mix" for AI meal planning. The three buckets are
// disjoint pools:
//   - mine:      recipes the user created
//   - favorites: recipes the user favorited that are NOT their own
//   - other:     published recipes (other users / standard catalog) that are
//                neither the user's own nor favorited
// The user expresses a percentage split across the three; we apportion the
// selected meal slots across the buckets, preferring higher-weight buckets when
// slots are scarce.

export type RecipeMixBucket = "mine" | "favorites" | "other";
export type RecipeMix = Record<RecipeMixBucket, number>;
export type RecipeBucketCounts = Record<RecipeMixBucket, number>;

// Tie-break order when weights/remainders are equal: prefer the user's own
// recipes, then favorites, then other.
export const RECIPE_MIX_BUCKETS: RecipeMixBucket[] = ["mine", "favorites", "other"];

export const DEFAULT_RECIPE_MIX: RecipeMix = { mine: 50, favorites: 25, other: 25 };

function clampPercent(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round(num)));
}

// Coerces arbitrary input into a valid mix whose integer parts sum to exactly
// 100. An all-zero (or empty) input falls back to the default mix.
export function normalizeRecipeMix(input: unknown): RecipeMix {
  const raw = (input ?? {}) as Partial<Record<RecipeMixBucket, unknown>>;
  const clamped: RecipeMix = {
    mine: clampPercent(raw.mine),
    favorites: clampPercent(raw.favorites),
    other: clampPercent(raw.other),
  };

  const total = clamped.mine + clamped.favorites + clamped.other;
  if (total === 0) {
    return { ...DEFAULT_RECIPE_MIX };
  }

  if (total === 100) {
    return clamped;
  }

  // Rescale to sum 100, then fix any rounding drift on the largest bucket so the
  // result is exact.
  const scaled: RecipeMix = {
    mine: Math.round((clamped.mine / total) * 100),
    favorites: Math.round((clamped.favorites / total) * 100),
    other: Math.round((clamped.other / total) * 100),
  };
  const scaledTotal = scaled.mine + scaled.favorites + scaled.other;
  const drift = 100 - scaledTotal;
  if (drift !== 0) {
    const largest = RECIPE_MIX_BUCKETS.reduce((best, bucket) =>
      scaled[bucket] > scaled[best] ? bucket : best
    );
    scaled[largest] += drift;
  }
  return scaled;
}

// Distributes `totalSlots` across the buckets proportionally to the mix, using
// largest-remainder apportionment. Empty buckets (no recipes available) are
// excluded and their share cascades to the remaining buckets. Ties are broken by
// weight, then by RECIPE_MIX_BUCKETS order.
export function apportionRecipeSlots(
  totalSlots: number,
  mix: RecipeMix,
  nonEmpty: Record<RecipeMixBucket, boolean>
): RecipeBucketCounts {
  const counts: RecipeBucketCounts = { mine: 0, favorites: 0, other: 0 };
  if (totalSlots <= 0) {
    return counts;
  }

  const candidates = RECIPE_MIX_BUCKETS.filter((bucket) => nonEmpty[bucket]);
  if (candidates.length === 0) {
    return counts;
  }

  // Restrict the weights to buckets that actually have recipes. If none of the
  // available buckets carry weight (e.g. the user weighted only an empty pool),
  // fall back to an even split across what's available.
  const weightSum = candidates.reduce((sum, bucket) => sum + mix[bucket], 0);
  const weightOf = (bucket: RecipeMixBucket) =>
    weightSum > 0 ? mix[bucket] : 1;
  const effectiveSum = weightSum > 0 ? weightSum : candidates.length;

  const remainders = candidates.map((bucket) => {
    const ideal = (totalSlots * weightOf(bucket)) / effectiveSum;
    const base = Math.floor(ideal);
    counts[bucket] = base;
    return { bucket, remainder: ideal - base };
  });

  let assigned = candidates.reduce((sum, bucket) => sum + counts[bucket], 0);
  let leftover = totalSlots - assigned;

  remainders.sort((a, b) => {
    if (b.remainder !== a.remainder) {
      return b.remainder - a.remainder;
    }
    if (weightOf(b.bucket) !== weightOf(a.bucket)) {
      return weightOf(b.bucket) - weightOf(a.bucket);
    }
    return RECIPE_MIX_BUCKETS.indexOf(a.bucket) - RECIPE_MIX_BUCKETS.indexOf(b.bucket);
  });

  let index = 0;
  while (leftover > 0 && remainders.length > 0) {
    const target = remainders[index % remainders.length]!;
    counts[target.bucket] += 1;
    leftover -= 1;
    index += 1;
  }

  return counts;
}
