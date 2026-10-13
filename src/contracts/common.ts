import { z } from '@hono/zod-openapi';

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
  };
};