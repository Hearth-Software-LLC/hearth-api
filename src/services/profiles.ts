import { supabaseAdmin } from "./supabase.js";
import type { VerifiedIdentity, VerifyToken } from "../middleware/auth.js";

// Every signed-in Hearth account gets a `profiles` row, whichever app it signed in from. The
// RevenueCat webhook, household sharing and Hearth Ship's Test Plans all hang off that row, so
// someone who only ever used Sated or Suffice still has their plans recorded on the server.

/** Accounts known to have a profile on this server instance, so each costs one query at most. */
const known = new Set<string>();

/** For tests: forget which accounts have been checked. */
export function resetEnsuredProfiles(): void {
  known.clear();
}

/**
 * Creates an empty profile row for the account if it has none. Never overwrites an existing one.
 * Returns whether the row exists afterwards. Fails quietly (false): a missing profile must never
 * block a request.
 */
export async function ensureProfile(userId: string): Promise<boolean> {
  if (known.has(userId)) return true;
  try {
    const { error } = await supabaseAdmin
      .from("profiles")
      .upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
    if (error) {
      // A deleted account (its auth user is gone) fails the foreign key; that's expected.
      console.warn("ensureProfile failed", error.message);
      return false;
    }
    known.add(userId);
    return true;
  } catch (error) {
    console.warn("ensureProfile failed", error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Whether this id belongs to a real, non-anonymous Hearth account, and if so makes sure it has a
 * profile. Used by the RevenueCat webhook, which only has the app user id to go on.
 */
export async function ensureProfileForAccount(userId: string): Promise<boolean> {
  if (known.has(userId)) return true;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return false;
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user || data.user.is_anonymous) return false;
  } catch (error) {
    console.warn("ensureProfileForAccount lookup failed", error instanceof Error ? error.message : error);
    return false;
  }
  return ensureProfile(userId);
}

/** Wraps a token verifier so every signed-in (non-anonymous) caller has a profile row. */
export function withProfiles(verify: VerifyToken): VerifyToken {
  return async (token) => {
    const identity: string | VerifiedIdentity = await verify(token);
    const userId = typeof identity === "string" ? identity : identity.userId;
    const anonymous = typeof identity === "string" ? false : identity.isAnonymous;
    if (!anonymous) await ensureProfile(userId);
    return identity;
  };
}
