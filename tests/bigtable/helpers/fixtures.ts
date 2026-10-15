import type { AiFeature, SubscriptionTier } from "../../../src/bigtable/lib/rate-limit.js";

type UsageFixture = {
  tier: SubscriptionTier;
  requestsUsed: number;
  requestsLimit: number;
  resetsAt: string;
  canMakeRequest: boolean;
  mealPlanCount?: number;
  groceryListCount?: number;
  monthKey?: string;
};

export function usageFixture(overrides: Partial<UsageFixture> = {}): UsageFixture {
  return {
    tier: "pro",
    requestsUsed: 0,
    requestsLimit: 1000000,
    resetsAt: "2026-06-01T00:00:00.000Z",
    canMakeRequest: true,
    mealPlanCount: 0,
    groceryListCount: 0,
    monthKey: "2026-05",
    ...overrides,
  };
}

type RevenueCatEvent = {
  id: string;
  type: string;
  app_user_id: string;
  entitlement_ids: string[];
  product_id: string;
  expires_at: string | null;
};

export function revenueCatEventFixture(overrides: Partial<RevenueCatEvent> = {}): RevenueCatEvent {
  return {
    id: "evt_default",
    type: "INITIAL_PURCHASE",
    app_user_id: "user-1",
    entitlement_ids: ["pro"],
    product_id: "com.stephenwarren.bigtable.pro.monthly",
    expires_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

type HouseholdFixture = {
  householdName: string;
  memberNames: string[];
  restrictions: string[];
};

export function householdFixture(overrides: Partial<HouseholdFixture> = {}): HouseholdFixture {
  return {
    householdName: "Household",
    memberNames: ["Alex", "Sam"],
    restrictions: ["no fish"],
    ...overrides,
  };
}

export function usageIncrementCall(profileId: string, feature: AiFeature, amount: number) {
  return {
    profileId,
    feature,
    amount,
  };
}
