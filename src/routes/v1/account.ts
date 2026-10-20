import { createRoute } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { errorSchema } from '../../contracts/common.js';
import type { ApiEnvironment } from '../../contracts/common.js';
import { ApiError } from '../../errors.js';
import { AccountDeletionError, deleteAnonymousAccount, deleteHearthAccount } from '../../services/account-deletion.js';

const errorResponse = (description: string) => ({ description, content: { 'application/json': { schema: errorSchema } } });

/** DELETE /v1/me: delete the caller's Hearth account, for every app. */
export function registerAccount(app: OpenAPIHono<ApiEnvironment>) {
  app.openapi(createRoute({
    method: 'delete',
    path: '/v1/me',
    tags: ['Identity'],
    summary: 'Delete the caller\'s Hearth account and everything every Hearth app keeps about them',
    description: 'BigTable: the same checks and cleanup as `DELETE /v1/bigtable/me` (409 `HOUSEHOLD_HAS_MEMBERS` while the caller runs a household with other people in it; nothing is deleted then). Hearken: groups pass to another member, and the caller\'s posts, replies, answers, reactions, questions, blocks and reports are deleted now. Suffice: every bank connection is removed at Plaid and here. RevenueCat: the customer is deleted. Then push tokens and the auth user. An anonymous session just deletes its auth user. Safe to retry after a failure.',
    security: [{ BearerAuth: [] }],
    responses: {
      204: { description: 'Deleted' },
      401: errorResponse('Invalid or missing token'),
      409: errorResponse('The caller still runs a BigTable household with other people in it'),
      502: errorResponse('Plaid failed'),
      503: errorResponse('A step failed or a required service is unavailable; the account is not fully deleted and the call can be retried'),
      504: errorResponse('Plaid timed out'),
    },
  }), async (context) => {
    const userId = context.get('userId');
    try {
      if (context.get('isAnonymous')) {
        await deleteAnonymousAccount(userId);
      } else if (await deleteHearthAccount(userId, { revenueCat: 'always' }) === 'household_has_members') {
        throw new ApiError(409, 'HOUSEHOLD_HAS_MEMBERS',
          'Remove the other people from your household in BigTable before deleting your account.');
      }
    } catch (error) {
      if (error instanceof AccountDeletionError) {
        console.error(`DELETE /v1/me ${error.step} failed`, error.failure);
        throw new ApiError(503, 'ACCOUNT_DELETION_FAILED', `${error.message}. Your account wasn’t fully deleted; try again.`);
      }
      throw error;
    }
    return context.body(null, 204);
  });
}
