import { NextRequest, NextResponse } from "../next-shim.js";

import { getUserIdFromAuthHeader } from "../lib/auth.js";
import { getUsageStatus } from "../lib/rate-limit.js";
import { ensureRevenueCatSubscriber } from "../../services/revenuecat.js";
import { serverError } from "../lib/server-error.js";
import { createTtlCache } from "../lib/ttl-cache.js";

type UsagePayload = {
  tier: string;
  requestsUsed: number;
  requestsLimit: number;
  resetsAt: string;
  canMakeRequest: boolean;
  mealPlanCount: number;
  groceryListCount: number;
};

const usageCache = createTtlCache<UsagePayload>(60_000);

export async function GET(request: NextRequest) {
  const userId = await getUserIdFromAuthHeader(request.headers.get("authorization"));
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cached = usageCache.get(userId);
  if (cached) {
    return NextResponse.json(cached);
  }

  try {
    try {
      // Best-effort sync so users are materialized in RevenueCat for support operations.
      await ensureRevenueCatSubscriber(userId);
    } catch (error) {
      console.warn("GET /api/usage/check revenuecat subscriber sync skipped", error);
    }

    const usage = await getUsageStatus(userId);

    const payload: UsagePayload = {
      tier: usage.tier,
      requestsUsed: usage.requestsUsed,
      requestsLimit: usage.requestsLimit,
      resetsAt: usage.resetsAt,
      canMakeRequest: usage.canMakeRequest,
      mealPlanCount: usage.mealPlanCount,
      groceryListCount: usage.groceryListCount,
    };

    usageCache.set(userId, payload);
    return NextResponse.json(payload);
  } catch (error) {
    return serverError("GET /api/usage/check failed", "Failed to check usage", error);
  }
}
