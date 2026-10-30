import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { createMiddleware } from 'hono/factory';
import type { Config } from '../config.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';

/** `signedInAt`: when the person last actually signed in (seconds), from Supabase's `amr` claim. */
export type VerifiedIdentity = { userId: string; isAnonymous: boolean; signedInAt?: number };

/** The newest sign-in time in a Supabase token's `amr` claim (refreshes don't change it). */
export function signedInAtOf(payload: Record<string, unknown>): number | undefined {
  const amr = payload.amr;
  if (!Array.isArray(amr)) return undefined;
  const times = amr.map((entry) => (entry && typeof entry === 'object' ? Number((entry as { timestamp?: unknown }).timestamp) : NaN)).filter(Number.isFinite);
  return times.length ? Math.max(...times) : undefined;
}
export type VerifyToken = (token: string) => Promise<string | VerifiedIdentity>;

export function createTokenVerifier(config: Config, resolver?: JWTVerifyGetKey): VerifyToken {
  if (!config.AUTH_ISSUER || !config.AUTH_AUDIENCE || !config.AUTH_JWKS_URL) {
    return async () => { throw new ApiError(503, 'AUTH_NOT_CONFIGURED', 'Authentication is not configured'); };
  }

  const issuer = config.AUTH_ISSUER;
  const audience = config.AUTH_AUDIENCE;
  const keySet = resolver ?? createRemoteJWKSet(new URL(config.AUTH_JWKS_URL), { timeoutDuration: 5000 });

  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keySet, {
        issuer,
        audience,
        algorithms: ['RS256', 'ES256'],
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || !payload.sub.trim()) {
        throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
      }
      const signedInAt = signedInAtOf(payload as Record<string, unknown>);
      return { userId: payload.sub, isAnonymous: payload.is_anonymous === true, ...(signedInAt === undefined ? {} : { signedInAt }) };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout)) {
        throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
      }
      throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable');
    }
  };
}

export function authMiddleware(verifyToken: VerifyToken) {
  return createMiddleware<ApiEnvironment>(async (context, next) => {
    const authorization = context.req.header('Authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    const token = match?.[1];
    if (!token || token.length > 8192) {
      throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
    }
    const identity = await verifyToken(token);
    context.set('userId', typeof identity === 'string' ? identity : identity.userId);
    context.set('isAnonymous', typeof identity === 'string' ? false : identity.isAnonymous);
    context.set('signedInAt', typeof identity === 'string' ? undefined : identity.signedInAt);
    await next();
  });
}