import { ApiError } from "../../errors.js";
import type { VerifiedIdentity, VerifyToken } from "../../middleware/auth.js";

// The BigTable handlers authenticate inside each handler (a few routes are public), so they
// share the API's JWT verifier through this module instead of the /v1 auth middleware.
let verifier: VerifyToken | null = null;

export function setBigTableTokenVerifier(verify: VerifyToken | null) {
  verifier = verify;
}

export function getBearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorizationHeader.trim());
  const token = match?.[1];
  if (!token || token.length > 8192) {
    return null;
  }

  return token;
}

// Returns the verified user ID, or null when the token is missing, invalid or belongs to an
// anonymous session. BigTable data needs a durable account, so anonymous users are refused.
export async function getUserIdFromAuthHeader(authorizationHeader: string | null): Promise<string | null> {
  const token = getBearerToken(authorizationHeader);
  if (!token || !verifier) {
    return null;
  }

  let identity: string | VerifiedIdentity;
  try {
    identity = await verifier(token);
  } catch (error) {
    // Authentication being unavailable (not configured, signing keys unreachable) must not
    // look like "signed out" to the app, so let it surface as a 503.
    if (error instanceof ApiError && error.status === 503) {
      throw error;
    }
    return null;
  }

  if (typeof identity === "string") {
    return identity;
  }

  return identity.isAnonymous ? null : identity.userId;
}
