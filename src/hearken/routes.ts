import { timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import type { Config } from '../config.js';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import type { HearkenService } from './service.js';
import { allowAll } from '../services/entitlements.js';
import type { EntitlementGate } from '../services/entitlements.js';

// MARK: Schemas

const uuid = z.uuid();
const name = z.string().trim().min(1).max(60);
const initials = z.string().trim().min(1).max(3);
const day = z.iso.date();
const clientId = z.string().min(1).max(128).optional();
const role = z.enum(['owner', 'leader', 'member']);
const reactionKind = z.enum(['heart', 'insight']);
const notifySchema = z.object({
  replies: z.boolean(), mentions: z.boolean(), allReplies: z.boolean(), question: z.boolean(), activity: z.boolean(),
}).openapi('HearkenNotifications');
const progressSchema = z.object({
  // Missing means unknown (null): older clients leave them out.
  weekStart: day.nullable().default(null),
  weekRead: z.number().int().min(0).max(10000),
  weekTotal: z.number().int().min(0).max(10000),
  lastDoneDay: day.nullable().default(null),
  chaptersRead: z.number().int().min(0).max(100000),
  streak: z.number().int().min(0).max(100000),
});
const reactionSchema = z.object({ kind: reactionKind, userId: z.string() });
const commentSchema = z.object({
  id: z.string(), targetType: z.enum(['item', 'answer']), targetId: z.string(), parentId: z.string().nullable(),
  authorId: z.string(), authorName: z.string(), body: z.string(), mentions: z.array(z.string()), mentionsEveryone: z.boolean(),
  createdAt: z.string(), reactions: z.array(reactionSchema),
}).openapi('HearkenComment');
const itemSchema = z.object({
  id: z.string(), kind: z.enum(['highlight', 'reflection']), chapterId: z.string(), startVerse: z.number().int(), endVerse: z.number().int(),
  text: z.string(), note: z.string(), reference: z.string(), authorId: z.string(), authorName: z.string(), createdAt: z.string(),
  reactions: z.array(reactionSchema), commentCount: z.number().int(), latestComment: commentSchema.nullable(),
}).openapi('HearkenItem');
const answerSchema = z.object({
  id: z.string(), questionId: z.string(), userId: z.string(), authorName: z.string(), body: z.string(), createdAt: z.string(),
  updatedAt: z.string(), reactions: z.array(reactionSchema), commentCount: z.number().int(),
}).openapi('HearkenAnswer');
const questionSchema = z.object({
  id: z.string(), text: z.string(), reference: z.string(), chapterId: z.string(), authorId: z.string(), authorName: z.string(),
  postAt: z.string(), closesAt: z.string(), hideAnswers: z.boolean(), isPosted: z.boolean(), isClosed: z.boolean(),
  answerCount: z.number().int(), answeredUserIds: z.array(z.string()), answersVisible: z.boolean(),
  myAnswer: answerSchema.nullable(), answers: z.array(answerSchema),
}).openapi('HearkenQuestion');
const memberSchema = z.object({
  userId: z.string(), name: z.string(), initials: z.string(), role, pending: z.boolean(), joinedAt: z.string().nullable(),
  progress: progressSchema.extend({ updatedAt: z.string().nullable() }).nullable(),
}).openapi('HearkenMember');
const groupSchema = z.object({
  id: z.string(), name: z.string(), symbol: z.string(), planId: z.string(), customPlan: z.record(z.string(), z.unknown()).nullable(),
  startDate: z.string(), ownerId: z.string(), ownerName: z.string(), role, inviteCode: z.string(), inviteURL: z.string(),
  members: z.array(memberSchema), items: z.array(itemSchema), question: questionSchema.nullable(),
  scheduledQuestion: questionSchema.nullable(), notifications: notifySchema, createdAt: z.string(), updatedAt: z.string(),
}).openapi('HearkenGroup');

const customPlan = z.record(z.string(), z.unknown()).nullable().optional()
  .refine((value) => value === undefined || value === null || JSON.stringify(value).length <= 20000, 'customPlan is too large');
const groupFields = {
  name,
  symbol: z.string().trim().min(1).max(64),
  planId: z.string().trim().min(1).max(64),
  customPlan,
  startDate: day,
};
const createGroupBody = z.object({ clientId, ...groupFields, displayName: name, initials }).strict().openapi('CreateHearkenGroup');
const patchGroupBody = z.object({
  name: groupFields.name.optional(), symbol: groupFields.symbol.optional(), planId: groupFields.planId.optional(),
  customPlan, startDate: day.optional(),
}).strict().openapi('UpdateHearkenGroup');
const joinBody = z.object({ displayName: name, initials }).strict().openapi('JoinHearkenGroup');
const progressBody = progressSchema.extend({ displayName: name.optional(), initials: initials.optional() }).strict().openapi('HearkenProgress');
const itemBody = z.object({
  clientId, kind: z.enum(['highlight', 'reflection']), chapterId: z.string().max(64), startVerse: z.number().int().min(0).max(1000),
  endVerse: z.number().int().min(0).max(1000), text: z.string().max(4000), note: z.string().max(2000),
  reference: z.string().max(80).optional(), authorName: name,
}).strict().refine((body) => body.kind === 'highlight' ? body.text.trim().length > 0 : body.note.trim().length > 0, 'Nothing to share')
  .openapi('CreateHearkenItem');
const commentBody = z.object({
  clientId, targetType: z.enum(['item', 'answer']), targetId: uuid, parentId: uuid.nullable().optional(),
  body: z.string().trim().min(1).max(1000), mentions: z.array(uuid).max(50).optional(), mentionsEveryone: z.boolean().optional(),
  authorName: name,
}).strict().openapi('CreateHearkenComment');
const questionBody = z.object({
  clientId, text: z.string().trim().min(1).max(300), reference: z.string().max(80).optional(), chapterId: z.string().max(64).optional(),
  postAt: z.iso.datetime({ offset: true }).optional(), closesAt: z.iso.datetime({ offset: true }).optional(),
  hideAnswers: z.boolean().optional(), authorName: name,
}).strict().openapi('CreateHearkenQuestion');
const questionPatch = z.object({
  text: z.string().trim().min(1).max(300).optional(), reference: z.string().max(80).optional(), hideAnswers: z.boolean().optional(),
}).strict().openapi('UpdateHearkenQuestion');
const answerBody = z.object({ body: z.string().trim().min(1).max(1000), authorName: name }).strict().openapi('HearkenAnswerInput');
const pushBody = z.object({
  token: z.string().regex(/^[0-9a-fA-F]{64,200}$/), environment: z.enum(['sandbox', 'production']), enabled: z.boolean(),
}).strict().openapi('HearkenPushToken');
const legacyId = z.string().min(1).max(255);
const importBody = z.object({
  clientId: z.string().min(1).max(128), ...groupFields, displayName: name, initials, ownerLegacyId: legacyId,
  progress: progressSchema.optional(),
  members: z.array(z.object({ legacyId, displayName: name, initials, progress: progressSchema.optional() })).max(60),
  items: z.array(z.object({
    legacyId, legacyAuthorId: legacyId, authorName: name, kind: z.enum(['highlight', 'reflection']), chapterId: z.string().max(64),
    startVerse: z.number().int().min(0).max(1000), endVerse: z.number().int().min(0).max(1000), text: z.string().max(4000),
    note: z.string().max(2000), reference: z.string().max(80).optional(), createdAt: z.iso.datetime({ offset: true }),
  })).max(500),
  reactions: z.array(z.object({ legacyItemId: legacyId, legacyUserId: legacyId, kind: reactionKind })).max(2000),
}).strict().openapi('ImportHearkenGroup');
const claimBody = z.object({
  migrationToken: z.string().min(16).max(128), legacyUserId: legacyId, displayName: name, initials,
}).strict().openapi('ClaimHearkenGroup');

const groupParams = z.object({ groupId: uuid.openapi({ param: { name: 'groupId', in: 'path' } }) });
const codeParams = z.object({
  code: z.string().regex(/^[A-Za-z2-9]{8}$/).openapi({ param: { name: 'code', in: 'path' } }),
});

// MARK: Route helpers

const errorCodes = {
  400: 'Invalid request', 401: 'Invalid or missing token', 403: 'Not allowed, or a signed-in Hearth account is required',
  404: 'Not found, or not a member', 409: 'Conflicts with the current state', 503: 'Storage unavailable',
} as const;
const errors = Object.fromEntries(Object.entries(errorCodes).map(([code, description]) => [
  code, { description, content: { 'application/json': { schema: errorSchema } } },
]));
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const noContent = { 204: { description: 'Done' } };
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(config: R) =>
  createRoute({ ...config, tags: ['Hearken'], security: [{ BearerAuth: [] }] } as R & { tags: string[] });

export type HearkenDependencies = {
  service: HearkenService | undefined;
  /** Checks Hearken access before creating or joining a group. Lets everyone through when not given. */
  requireAccess?: EntitlementGate;
};
const needsPlan = { 402: json(errorSchema, 'Needs Hearken Plus or Hearth+ (only when ENFORCE_ENTITLEMENTS is on)') };

export function registerHearken(app: OpenAPIHono<ApiEnvironment>, config: Config, dependencies: HearkenDependencies) {
  const service = () => {
    if (!dependencies.service) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Study groups are not configured');
    return dependencies.service;
  };

  app.use('/v1/hearken/*', async (context, next) => {
    if (context.get('isAnonymous')) {
      throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to use study groups');
    }
    // Every write carries a JSON body, except reactions (PUT with nothing to send).
    const hasBody = ['POST', 'PATCH'].includes(context.req.method)
      || (context.req.method === 'PUT' && !context.req.path.includes('/reactions/'));
    if (hasBody && !context.req.path.endsWith('/invite-code')
      && context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ApiError(400, 'INVALID_REQUEST', 'An application/json body is required');
    }
    await next();
  });
  app.use('/v1/hearken/groups/import', bodyLimit({
    maxSize: 2_000_000, onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); },
  }));
  app.use('/v1/hearken/*', async (context, next) => {
    if (context.req.path === '/v1/hearken/groups/import') return next();
    return bodyLimit({ maxSize: 64_000, onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); } })(context, next);
  });

  const me = (context: { get: (key: 'userId') => string }) => context.get('userId');
  const requireAccess = dependencies.requireAccess ?? allowAll;

  // MARK: Groups

  app.openapi(route({
    method: 'get', path: '/v1/hearken/groups', summary: 'The caller’s study groups, each with members, recent posts and this week’s question',
    responses: { 200: json(z.object({ items: z.array(groupSchema) }), 'Groups'), ...errors },
  }), async (context) => context.json({ items: await service().listGroups(me(context)) }, 200));

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups', summary: 'Create a group. Repeating a clientId returns the same group',
    request: body(createGroupBody),
    responses: { 201: json(groupSchema, 'The new group'), ...errors, ...needsPlan },
  }), async (context) => {
    await requireAccess(me(context), 'hearken');
    return context.json(await service().createGroup(me(context), context.req.valid('json')), 201);
  });

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/import', summary: 'Move a CloudKit group to the server (owner’s device)',
    request: body(importBody),
    responses: { 201: json(z.object({ group: groupSchema, migrationToken: z.string() }), 'Imported group'), ...errors },
  }), async (context) => context.json(await service().importGroup(me(context), context.req.valid('json')), 201));

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/claim', summary: 'Take your seat in a group moved from CloudKit',
    request: body(claimBody),
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(await service().claimGroup(me(context), context.req.valid('json')), 200));

  app.openapi(route({
    method: 'get', path: '/v1/hearken/groups/{groupId}', summary: 'One group',
    request: { params: groupParams },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(await service().getGroup(me(context), context.req.valid('param').groupId), 200));

  app.openapi(route({
    method: 'patch', path: '/v1/hearken/groups/{groupId}', summary: 'Rename the group or change its plan (owner)',
    request: { params: groupParams, ...body(patchGroupBody) },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(
    await service().updateGroup(me(context), context.req.valid('param').groupId, context.req.valid('json')), 200,
  ));

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}', summary: 'Delete the group for everyone (owner)',
    request: { params: groupParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    await service().deleteGroup(me(context), context.req.valid('param').groupId);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/{groupId}/invite-code', summary: 'Replace the invite code (owner or leader)',
    request: { params: groupParams },
    responses: { 200: json(z.object({ inviteCode: z.string(), inviteURL: z.string() }), 'The new invite'), ...errors },
  }), async (context) => context.json(await service().rotateInvite(me(context), context.req.valid('param').groupId), 200));

  app.openapi(route({
    method: 'get', path: '/v1/hearken/invites/{code}', summary: 'What an invite code joins',
    request: { params: codeParams },
    responses: {
      200: json(z.object({
        groupId: z.string(), name: z.string(), symbol: z.string(), planId: z.string(), ownerName: z.string(),
        memberCount: z.number().int(), isMember: z.boolean(),
      }).openapi('HearkenInvite'), 'Invite preview'),
      ...errors,
    },
  }), async (context) => context.json(await service().previewInvite(me(context), context.req.valid('param').code), 200));

  app.openapi(route({
    method: 'post', path: '/v1/hearken/invites/{code}/join', summary: 'Join with an invite code',
    request: { params: codeParams, ...body(joinBody) },
    responses: { 200: json(groupSchema, 'The group'), ...errors, ...needsPlan },
  }), async (context) => {
    await requireAccess(me(context), 'hearken');
    return context.json(await service().join(me(context), context.req.valid('param').code, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}/members/{userId}',
    summary: 'Leave (your own id) or remove someone. An owner who leaves hands the group on',
    request: { params: groupParams.extend({ userId: z.string().min(1).max(300).openapi({ param: { name: 'userId', in: 'path' } }) }) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, userId } = context.req.valid('param');
    await service().removeMember(me(context), groupId, userId);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'put', path: '/v1/hearken/groups/{groupId}/members/{userId}/role', summary: 'Make someone a leader, member or the owner (owner)',
    request: { params: groupParams.extend({ userId: uuid.openapi({ param: { name: 'userId', in: 'path' } }) }), ...body(z.object({ role }).strict()) },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => {
    const { groupId, userId } = context.req.valid('param');
    return context.json(await service().setRole(me(context), groupId, userId, context.req.valid('json').role), 200);
  });

  app.openapi(route({
    method: 'put', path: '/v1/hearken/groups/{groupId}/progress', summary: 'Your reading progress on the group’s plan',
    request: { params: groupParams, ...body(progressBody) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const input = context.req.valid('json');
    await service().putProgress(me(context), context.req.valid('param').groupId, {
      ...input, displayName: input.displayName, initials: input.initials,
    });
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'put', path: '/v1/hearken/groups/{groupId}/notifications', summary: 'What this group notifies you about',
    request: { params: groupParams, ...body(notifySchema.partial().strict()) },
    responses: { 200: json(notifySchema, 'Your settings'), ...errors },
  }), async (context) => context.json(
    await service().setNotifications(me(context), context.req.valid('param').groupId, context.req.valid('json')), 200,
  ));

  // MARK: Posts and reactions

  app.openapi(route({
    method: 'get', path: '/v1/hearken/groups/{groupId}/items', summary: 'Older posts, 50 at a time',
    request: { params: groupParams, query: z.object({ before: z.iso.datetime({ offset: true }).optional() }) },
    responses: { 200: json(z.object({ items: z.array(itemSchema) }), 'Posts'), ...errors },
  }), async (context) => context.json({
    items: await service().listItems(me(context), context.req.valid('param').groupId, context.req.valid('query').before),
  }, 200));

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/{groupId}/items', summary: 'Share a highlight or reflection',
    request: { params: groupParams, ...body(itemBody) },
    responses: { 201: json(itemSchema, 'The post'), ...errors },
  }), async (context) => context.json(
    await service().createItem(me(context), context.req.valid('param').groupId, context.req.valid('json')), 201,
  ));

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}/items/{itemId}', summary: 'Delete a post (its author, the owner or a leader)',
    request: { params: groupParams.extend({ itemId: uuid.openapi({ param: { name: 'itemId', in: 'path' } }) }) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, itemId } = context.req.valid('param');
    await service().deleteItem(me(context), groupId, itemId);
    return context.body(null, 204);
  });

  const reactionParams = groupParams.extend({
    targetType: z.enum(['item', 'comment', 'answer']).openapi({ param: { name: 'targetType', in: 'path' } }),
    targetId: uuid.openapi({ param: { name: 'targetId', in: 'path' } }),
    kind: reactionKind.openapi({ param: { name: 'kind', in: 'path' } }),
  });
  for (const method of ['put', 'delete'] as const) {
    app.openapi(route({
      method, path: '/v1/hearken/groups/{groupId}/reactions/{targetType}/{targetId}/{kind}',
      summary: method === 'put' ? 'Add your reaction' : 'Remove your reaction',
      request: { params: reactionParams },
      responses: { ...noContent, ...errors },
    }), async (context) => {
      const { groupId, targetType, targetId, kind } = context.req.valid('param');
      await service().react(me(context), groupId, targetType, targetId, kind, method === 'put');
      return context.body(null, 204);
    });
  }

  // MARK: Discussion

  app.openapi(route({
    method: 'get', path: '/v1/hearken/groups/{groupId}/comments', summary: 'The replies on a post or answer, oldest first',
    request: { params: groupParams, query: z.object({ targetType: z.enum(['item', 'answer']), targetId: uuid }) },
    responses: { 200: json(z.object({ items: z.array(commentSchema) }), 'Replies'), ...errors },
  }), async (context) => {
    const { targetType, targetId } = context.req.valid('query');
    return context.json({ items: await service().listComments(me(context), context.req.valid('param').groupId, targetType, targetId) }, 200);
  });

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/{groupId}/comments', summary: 'Reply to a post, an answer or another reply',
    request: { params: groupParams, ...body(commentBody) },
    responses: { 201: json(commentSchema, 'The reply'), ...errors },
  }), async (context) => context.json(
    await service().createComment(me(context), context.req.valid('param').groupId, context.req.valid('json')), 201,
  ));

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}/comments/{commentId}', summary: 'Delete a reply and the replies under it',
    request: { params: groupParams.extend({ commentId: uuid.openapi({ param: { name: 'commentId', in: 'path' } }) }) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, commentId } = context.req.valid('param');
    await service().deleteComment(me(context), groupId, commentId);
    return context.body(null, 204);
  });

  // MARK: Weekly question

  const questionParams = groupParams.extend({ questionId: uuid.openapi({ param: { name: 'questionId', in: 'path' } }) });

  app.openapi(route({
    method: 'get', path: '/v1/hearken/groups/{groupId}/questions', summary: 'Posted questions, newest first',
    request: { params: groupParams },
    responses: { 200: json(z.object({ items: z.array(questionSchema) }), 'Questions'), ...errors },
  }), async (context) => context.json({ items: await service().listQuestions(me(context), context.req.valid('param').groupId) }, 200));

  app.openapi(route({
    method: 'post', path: '/v1/hearken/groups/{groupId}/questions', summary: 'Post or schedule the weekly question (owner or leader)',
    request: { params: groupParams, ...body(questionBody) },
    responses: { 201: json(questionSchema, 'The question'), ...errors },
  }), async (context) => context.json(
    await service().createQuestion(me(context), context.req.valid('param').groupId, context.req.valid('json')), 201,
  ));

  app.openapi(route({
    method: 'patch', path: '/v1/hearken/groups/{groupId}/questions/{questionId}', summary: 'Edit a question nobody has answered yet',
    request: { params: questionParams, ...body(questionPatch) },
    responses: { 200: json(questionSchema, 'The question'), ...errors },
  }), async (context) => {
    const { groupId, questionId } = context.req.valid('param');
    return context.json(await service().updateQuestion(me(context), groupId, questionId, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}/questions/{questionId}', summary: 'Delete a question',
    request: { params: questionParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, questionId } = context.req.valid('param');
    await service().deleteQuestion(me(context), groupId, questionId);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'put', path: '/v1/hearken/groups/{groupId}/questions/{questionId}/answer',
    summary: 'Post or edit your answer. Returns the question, now showing everyone’s answers',
    request: { params: questionParams, ...body(answerBody) },
    responses: { 200: json(questionSchema, 'The question'), ...errors },
  }), async (context) => {
    const { groupId, questionId } = context.req.valid('param');
    return context.json(await service().answer(me(context), groupId, questionId, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/groups/{groupId}/questions/{questionId}/answer', summary: 'Delete your answer',
    request: { params: questionParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, questionId } = context.req.valid('param');
    await service().deleteAnswer(me(context), groupId, questionId);
    return context.body(null, 204);
  });

  // MARK: Account and devices

  app.openapi(route({
    method: 'put', path: '/v1/hearken/push-tokens', summary: 'Register or remove this device for study group notifications',
    request: body(pushBody),
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { token, environment, enabled } = context.req.valid('json');
    await service().registerPushToken(me(context), token, environment, enabled);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'delete', path: '/v1/hearken/me',
    summary: 'Delete everything study groups keep about you (for account deletion). Owned groups pass to another member',
    responses: { ...noContent, ...errors },
  }), async (context) => {
    await service().deleteUser(me(context));
    return context.body(null, 204);
  });

  // MARK: Scheduled jobs (Vercel Cron), outside /v1 so no user token is needed

  app.get('/internal/hearken/cron', async (context) => {
    const expected = config.CRON_SECRET;
    const given = context.req.header('Authorization') ?? '';
    const valid = expected !== undefined && given.length === expected.length + 7
      && timingSafeEqual(Buffer.from(given), Buffer.from(`Bearer ${expected}`));
    if (!valid) throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required');
    return context.json(await service().runScheduled(), 200);
  });

  // MARK: Invite links

  // iOS opens /hearken/join/<code> in Hearken (apple-app-site-association). Without the app, explain.
  app.get('/hearken/join/:code', (context) => {
    const code = context.req.param('code').toUpperCase();
    const safe = /^[A-Z2-9]{8}$/.test(code) ? code : '';
    context.header('Cache-Control', 'public, max-age=300');
    return context.html(joinPage(safe), 200);
  });
}

const joinPage = (code: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Join a study group in Hearken</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  p { margin: 0 auto 16px; opacity: 0.75; max-width: 22rem; }
  .code { font: 600 28px ui-monospace, SFMono-Regular, monospace; letter-spacing: 4px; margin: 8px 0 20px; }
</style>
</head>
<body>
<main>
<h1>You're invited to a study group</h1>
<p>Open this link on an iPhone or iPad with Hearken installed${code ? ', or enter this code in Hearken under Study Groups › Join' : ''}.</p>
${code ? `<div class="code">${code}</div>` : ''}
</main>
</body>
</html>`;
