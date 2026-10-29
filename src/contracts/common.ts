import { z } from '@hono/zod-openapi';
import type { Member as StudioMember } from '../studio/team.js';

export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
  }),
}).openapi('ApiError');

export type ApiEnvironment = {
  Variables: {
    requestId: string;
    userId: string;
    isAnonymous: boolean;
    /** The error code a failed request answered with, for the request log. */
    errorCode: string | undefined;
    /** The caller's Hearth Studio membership, on /v1/social, /v1/studio and /v1/library (studio/gate.ts). */
    studioMember: StudioMember | undefined;
  };
};