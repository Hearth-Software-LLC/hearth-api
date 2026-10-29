import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ApiError } from '../errors.js';

/**
 * Seals access tokens (Plaid's, and the social accounts') before they're stored (AES-256-GCM). The key lives in the API's
 * environment, never in the database. Each token is bound to its owner and item, so a sealed
 * value copied onto another row won't open. Format: `v1.<base64(iv | tag | ciphertext)>`.
 */
export type TokenSeal = {
  seal: (accessToken: string, ownerId: string, itemId: string) => string;
  open: (sealed: string, ownerId: string, itemId: string) => string;
};

export function createTokenSeal(
  base64Key: string,
  /** What the tokens are for; a token sealed for one purpose won't open for another. */
  purpose = 'plaid-access-token',
  unavailable = 'Bank connections are temporarily unavailable',
): TokenSeal {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('The token key must be 32 bytes');
  const context = (ownerId: string, itemId: string) => Buffer.from(`${purpose}:${ownerId}:${itemId}`, 'utf8');

  return {
    seal(accessToken, ownerId, itemId) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(context(ownerId, itemId));
      const body = Buffer.concat([cipher.update(accessToken, 'utf8'), cipher.final()]);
      return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
    },
    open(sealed, ownerId, itemId) {
      try {
        if (!sealed.startsWith('v1.')) throw new Error('unknown format');
        const raw = Buffer.from(sealed.slice(3), 'base64');
        const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
        decipher.setAAD(context(ownerId, itemId));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
      } catch {
        throw new ApiError(503, 'STORAGE_UNAVAILABLE', unavailable);
      }
    },
  };
}
