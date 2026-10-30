import { describe, expect, it } from 'vitest';
import { signedInAtOf } from '../../src/middleware/auth.js';

describe('sign-in time', () => {
  it('reads the newest sign-in from Supabase’s amr claim', () => {
    expect(signedInAtOf({ amr: [{ method: 'oauth', timestamp: 1_790_000_000 }, { method: 'totp', timestamp: 1_790_000_500 }] })).toBe(1_790_000_500);
    expect(signedInAtOf({ amr: [] })).toBeUndefined();
    expect(signedInAtOf({})).toBeUndefined();
    expect(signedInAtOf({ amr: [{ method: 'oauth' }] })).toBeUndefined();
  });
});
