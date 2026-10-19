import type { MiddlewareHandler } from 'hono';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { APP_PLAN_NAME, hasAppAccess } from '../bigtable/lib/entitlements.js';
import type { EffectiveEntitlement, HearthApp } from '../bigtable/lib/entitlements.js';

/** Someone's active entitlements: their own plus their household organizer's. */
export type EntitlementSource = (userId: string) => Promise<EffectiveEntitlement[]>;

/** Throws 402 ENTITLEMENT_REQUIRED unless the user may use the app's paid features. */
export type EntitlementGate = (userId: string, app: HearthApp) => Promise<void>;

export const allowAll: EntitlementGate = async () => undefined;

/** The caller's entitlements, or a 503 when they can't be read. */
export async function loadEntitlements(source: EntitlementSource | undefined, userId: string) {
  if (!source) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Subscriptions are not configured');
  try {
    return await source(userId);
  } catch (error) {
    console.error('entitlement lookup failed', error instanceof Error ? error.message : error);
    throw new ApiError(503, 'ENTITLEMENTS_UNAVAILABLE', 'Subscriptions could not be checked; try again');
  }
}

/** A gate that checks entitlements when `enforce` is on, and lets everything through when off. */
export function createEntitlementGate(enforce: boolean, source: EntitlementSource | undefined): EntitlementGate {
  if (!enforce) return allowAll;
  return async (userId, app) => {
    const entitlements = await loadEntitlements(source, userId);
    if (!hasAppAccess(entitlements, app)) {
      throw new ApiError(402, 'ENTITLEMENT_REQUIRED', `This needs ${APP_PLAN_NAME[app]} or Hearth+`);
    }
  };
}

/** Middleware form of a gate, for whole route groups. */
export function requireApp(gate: EntitlementGate, app: HearthApp): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    await gate(context.get('userId'), app);
    await next();
  };
}
