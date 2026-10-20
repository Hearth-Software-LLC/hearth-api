import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { REPORT_APPS, REPORT_KINDS, REPORT_REASONS, REPORTS_PER_DAY } from '../../services/reports.js';
import type { ReportStore } from '../../services/reports.js';

const reportBody = z.object({
  app: z.enum(REPORT_APPS),
  kind: z.enum(REPORT_KINDS),
  targetId: z.string().trim().min(1).max(300),
  groupId: z.uuid().nullable().optional(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000).nullable().optional(),
}).strict().openapi('NewReport');

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });

/** POST /v1/reports: anyone signed in with Apple can report content or a person for review. */
export function registerReports(app: OpenAPIHono<ApiEnvironment>, store: ReportStore | undefined) {
  app.use('/v1/reports', async (context, next) => {
    // Reports need a durable account behind them, so anonymous sessions can't send one.
    if (context.get('isAnonymous')) throw new ApiError(401, 'UNAUTHORIZED', 'Sign in with Apple to report content');
    if (context.req.method === 'POST'
      && context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ApiError(400, 'INVALID_REQUEST', 'An application/json body is required');
    }
    await next();
  }, bodyLimit({ maxSize: 4096, onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); } }));

  app.openapi(createRoute({
    method: 'post',
    path: '/v1/reports',
    tags: ['Moderation'],
    summary: 'Report content or a person for review',
    description: `Stored for review within 24 hours. At most ${REPORTS_PER_DAY} reports per person per day. \`groupId\` is the Hearken group the content is in, when there is one.`,
    security: [{ BearerAuth: [] }],
    request: { body: { required: true, content: { 'application/json': { schema: reportBody } } } },
    responses: {
      201: {
        description: 'Report received',
        content: { 'application/json': { schema: z.object({ id: z.string() }).openapi('ReportReceipt') } },
      },
      400: errorResponse('Invalid request'),
      401: errorResponse('Invalid or missing token, or an anonymous session'),
      429: errorResponse('Daily report limit reached'),
      503: errorResponse('Storage unavailable'),
    },
  }), async (context) => {
    if (!store) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Reports are not configured');
    const input = context.req.valid('json');
    const id = await store.create(context.get('userId'), {
      app: input.app,
      kind: input.kind,
      targetId: input.targetId,
      groupId: input.groupId ?? null,
      reason: input.reason,
      details: input.details ? input.details : null,
    });
    if (!id) {
      throw new ApiError(429, 'RATE_LIMITED', `You can send up to ${REPORTS_PER_DAY} reports a day. Try again tomorrow.`, 3600);
    }
    return context.json({ id }, 201);
  });
}
