import { supabaseAdmin } from "./supabase.js";

type AiUsageRow = {
  id: string;
  profile_id: string;
  month_key: string;
  meal_plan_count: number;
  grocery_list_count: number;
};

export type SubscriptionTier = "free" | "pro";
export type AiFeature = "meal_plan" | "grocery_list";

const LIMITS: Record<SubscriptionTier, number> = {
  free: 0,
  pro: 1000000,
};

function normalizeSubscriptionTier(tier: unknown): SubscriptionTier {
  if (tier === "pro") {
    return "pro";
  }

  // Backward compatibility for legacy tiers from older pricing models.
  if (tier === "basic" || tier === "family" || tier === "pantry") {
    return "pro";
  }

  return "free";
}

export function monthKeyUTC(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function nextMonthStartUTC(date = new Date()): string {
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return next.toISOString();
}

async function getOrCreateSubscriptionTier(profileId: string): Promise<SubscriptionTier> {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("tier")
    .eq("profile_id", profileId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const tier = normalizeSubscriptionTier(data?.tier);
  if (data?.tier) {
    return tier;
  }

  const { error: insertError } = await supabaseAdmin.from("subscriptions").insert({
    profile_id: profileId,
    tier: "free",
    revenuecat_user_id: profileId,
  });

  if (insertError) {
    throw new Error(insertError.message);
  }

  return "free";
}

async function getUsage(profileId: string, key: string): Promise<AiUsageRow | null> {
  const { data, error } = await supabaseAdmin
    .from("ai_usage")
    .select("id, profile_id, month_key, meal_plan_count, grocery_list_count")
    .eq("profile_id", profileId)
    .eq("month_key", key)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

/**
 * The tier that applies to someone: their own, or their household organizer's when that's
 * better. Families share the organizer's subscription (joined with the household join code),
 * with no limit on how many people.
 */
async function effectiveTier(profileId: string): Promise<SubscriptionTier> {
  const own = await getOrCreateSubscriptionTier(profileId);
  if (own !== "free") {
    return own;
  }
  const { data, error } = await supabaseAdmin
    .from("household_memberships")
    .select("organizer_id")
    .eq("member_id", profileId)
    .maybeSingle();
  const organizerId = !error && typeof data?.organizer_id === "string" ? data.organizer_id : null;
  if (!organizerId || organizerId === profileId) {
    return own;
  }
  const organizer = await supabaseAdmin
    .from("subscriptions")
    .select("tier")
    .eq("profile_id", organizerId)
    .maybeSingle();
  if (organizer.error) {
    return own;
  }
  const organizerTier = normalizeSubscriptionTier(organizer.data?.tier);
  return organizerTier !== "free" ? organizerTier : own;
}

export async function getUsageStatus(profileId: string) {
  const key = monthKeyUTC();
  const [tier, usage] = await Promise.all([effectiveTier(profileId), getUsage(profileId, key)]);

  const mealPlanCount = usage?.meal_plan_count ?? 0;
  const groceryListCount = usage?.grocery_list_count ?? 0;
  const requestsUsed = mealPlanCount + groceryListCount;
  const requestsLimit = LIMITS[tier];

  return {
    tier,
    monthKey: key,
    mealPlanCount,
    groceryListCount,
    requestsUsed,
    requestsLimit,
    resetsAt: nextMonthStartUTC(),
    canMakeRequest: tier !== "free" ? true : requestsUsed < requestsLimit,
  };
}

export async function incrementUsage(profileId: string, feature: AiFeature) {
  const key = monthKeyUTC();
  const { error } = await supabaseAdmin.rpc("increment_ai_usage", {
    p_profile_id: profileId,
    p_month_key: key,
    p_feature: feature,
    p_amount: 1,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export function canConsumeCredits(
  usage: { requestsUsed: number; requestsLimit: number; tier?: SubscriptionTier },
  credits: number
) {
  if (!Number.isFinite(credits) || credits <= 0) {
    return false;
  }

  if (usage.tier && usage.tier !== "free") {
    return true;
  }

  return usage.requestsUsed + credits <= usage.requestsLimit;
}

export async function incrementUsageBy(profileId: string, feature: AiFeature, amount: number) {
  const credits = Math.max(1, Math.trunc(amount));
  const key = monthKeyUTC();
  const { error } = await supabaseAdmin.rpc("increment_ai_usage", {
    p_profile_id: profileId,
    p_month_key: key,
    p_feature: feature,
    p_amount: credits,
  });

  if (error) {
    throw new Error(error.message);
  }
}
