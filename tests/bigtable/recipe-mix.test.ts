import { describe, expect, it } from "vitest";

import {
  apportionRecipeSlots,
  DEFAULT_RECIPE_MIX,
  normalizeRecipeMix,
  type RecipeMix,
} from "../../src/bigtable/lib/recipe-mix.js";

const allNonEmpty = { mine: true, favorites: true, other: true };

function sum(counts: { mine: number; favorites: number; other: number }) {
  return counts.mine + counts.favorites + counts.other;
}

describe("normalizeRecipeMix", () => {
  it("passes through a valid mix that already sums to 100", () => {
    expect(normalizeRecipeMix({ mine: 50, favorites: 25, other: 25 })).toEqual({
      mine: 50,
      favorites: 25,
      other: 25,
    });
  });

  it("falls back to the default for empty/all-zero input", () => {
    expect(normalizeRecipeMix(undefined)).toEqual(DEFAULT_RECIPE_MIX);
    expect(normalizeRecipeMix({ mine: 0, favorites: 0, other: 0 })).toEqual(DEFAULT_RECIPE_MIX);
  });

  it("rescales values that do not sum to 100 to an exact total of 100", () => {
    const result = normalizeRecipeMix({ mine: 1, favorites: 1, other: 1 });
    expect(sum(result)).toBe(100);
  });

  it("clamps out-of-range values", () => {
    const result = normalizeRecipeMix({ mine: 200, favorites: -50, other: 10 });
    expect(result.favorites).toBe(0);
    expect(sum(result)).toBe(100);
  });
});

describe("apportionRecipeSlots", () => {
  it("distributes proportionally with largest-remainder rounding", () => {
    const mix: RecipeMix = { mine: 50, favorites: 25, other: 25 };
    const counts = apportionRecipeSlots(6, mix, allNonEmpty);
    expect(sum(counts)).toBe(6);
    expect(counts.mine).toBe(3);
    // The two equal 25% buckets share the remaining 3 slots (2 + 1).
    expect(counts.favorites + counts.other).toBe(3);
  });

  it("prefers higher-weight buckets when slots are scarce (2 meals, 40/30/30)", () => {
    const counts = apportionRecipeSlots(2, { other: 40, mine: 30, favorites: 30 }, allNonEmpty);
    expect(sum(counts)).toBe(2);
    // The 40% bucket wins a slot; one of the two 30% buckets gets the other.
    expect(counts.other).toBe(1);
    expect(counts.mine + counts.favorites).toBe(1);
  });

  it("gives a zero-weight bucket no slots even when it has recipes", () => {
    const counts = apportionRecipeSlots(5, { mine: 60, favorites: 40, other: 0 }, allNonEmpty);
    expect(counts.other).toBe(0);
    expect(counts.mine).toBe(3);
    expect(counts.favorites).toBe(2);
  });

  it("cascades an empty weighted bucket's share to the available buckets", () => {
    // User asked for 100% of their own recipes, but they have none.
    const counts = apportionRecipeSlots(4, { mine: 100, favorites: 0, other: 0 }, {
      mine: false,
      favorites: true,
      other: true,
    });
    expect(counts.mine).toBe(0);
    expect(sum(counts)).toBe(4);
    expect(counts.favorites).toBe(2);
    expect(counts.other).toBe(2);
  });

  it("returns all zeros when no bucket has recipes", () => {
    const counts = apportionRecipeSlots(7, DEFAULT_RECIPE_MIX, {
      mine: false,
      favorites: false,
      other: false,
    });
    expect(sum(counts)).toBe(0);
  });

  it("excludes an empty bucket but honors weights among the rest", () => {
    const counts = apportionRecipeSlots(4, { mine: 50, favorites: 25, other: 25 }, {
      mine: true,
      favorites: false,
      other: true,
    });
    expect(counts.favorites).toBe(0);
    expect(sum(counts)).toBe(4);
    // mine (50) vs other (25) over 4 slots -> ~2.67 / 1.33 -> 3 / 1.
    expect(counts.mine).toBe(3);
    expect(counts.other).toBe(1);
  });
});
