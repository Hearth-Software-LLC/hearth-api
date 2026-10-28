import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono, RouteConfig } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { errorSchema } from '../contracts/common.js';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { allowAll } from '../services/entitlements.js';
import type { EntitlementGate } from '../services/entitlements.js';
import { BUDGET_LIMITS } from './service.js';
import type { BudgetGroupsService } from './service.js';

// MARK: Schemas

const uuid = z.uuid();
const day = z.iso.date();
const cents = z.number().int().min(1).max(100_000_000);
const groupName = z.string().trim().min(1).max(60);
const displayName = z.string().trim().min(1).max(40);
const householdKey = z.string().trim().max(128).nullable().optional();
const payee = z.string().trim().min(1).max(120);
const note = z.string().trim().max(500).nullable().optional();
const role = z.enum(['owner', 'member']);

const memberSchema = z.object({
  userId: z.string(), displayName: z.string(), householdKey: z.string().nullable(), role, joinedAt: z.string(),
}).openapi('BudgetGroupMember');
const expenseSchema = z.object({
  id: z.string(), clientId: z.string(), payee: z.string(), amountCents: z.number().int(), date: z.string(), note: z.string().nullable(),
  paidBy: z.string(), createdAt: z.string(),
}).openapi('BudgetExpense');
const settlementSchema = z.object({
  id: z.string(), clientId: z.string(), fromUserId: z.string(), toUserId: z.string(), amountCents: z.number().int(),
  createdBy: z.string(), createdAt: z.string(),
}).openapi('BudgetSettlement');
const summaryFields = {
  id: z.string(), name: z.string(), planCents: z.number().int(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  ownerId: z.string(), role, memberCount: z.number().int(), spentCents: z.number().int(), myPaidCents: z.number().int(),
  updatedAt: z.string(),
};
const summarySchema = z.object(summaryFields).openapi('BudgetGroupSummary');
const groupSchema = z.object({
  ...summaryFields,
  inviteCode: z.string().nullable().openapi({ description: 'The owner’s invite code; null for everyone else' }),
  inviteURL: z.string().nullable().openapi({ description: 'The owner’s invite link; null for everyone else' }),
  members: z.array(memberSchema),
  expenses: z.array(expenseSchema).openapi({ description: 'Newest date first' }),
  settlements: z.array(settlementSchema).openapi({ description: 'Newest first' }),
}).openapi('BudgetGroup');
const inviteSchema = z.object({
  inviteCode: z.string(), inviteURL: z.string(),
}).openapi('BudgetGroupInviteCode');
const invitePreviewSchema = z.object({
  groupId: z.string(), name: z.string(), planCents: z.number().int(), startDate: z.string().nullable(), endDate: z.string().nullable(),
  ownerName: z.string(), memberNames: z.array(z.string()), memberCount: z.number().int(), alreadyMember: z.boolean(),
}).openapi('BudgetGroupInvite');

const planCents = z.number().int().min(0).max(100_000_000);
const datesInOrder = (body: { startDate?: string | null | undefined; endDate?: string | null | undefined }) =>
  !body.startDate || !body.endDate || body.endDate >= body.startDate;
const createGroupBody = z.object({
  name: groupName, planCents, startDate: day.nullable().optional(), endDate: day.nullable().optional(), displayName, householdKey,
}).strict().refine(datesInOrder, 'The end date can’t be before the start date').openapi('CreateBudgetGroup');
const patchGroupBody = z.object({
  name: groupName.optional(), planCents: planCents.optional(), startDate: day.nullable().optional(), endDate: day.nullable().optional(),
}).strict().refine(datesInOrder, 'The end date can’t be before the start date').openapi('UpdateBudgetGroup');
const joinBody = z.object({ displayName, householdKey }).strict().openapi('JoinBudgetGroup');
const expenseFields = { clientId: uuid, payee, amountCents: cents, date: day, note };
const expenseBody = z.object(expenseFields).strict().openapi('CreateBudgetExpense');
const batchBody = z.object({
  expenses: z.array(z.object(expenseFields).strict()).min(1).max(BUDGET_LIMITS.expensesPerBatch),
}).strict().openapi('CreateBudgetExpenses');
const patchExpenseBody = z.object({
  payee: payee.optional(), amountCents: cents.optional(), date: day.optional(), note,
}).strict().openapi('UpdateBudgetExpense');
const settlementBody = z.object({
  clientId: uuid, fromUserId: uuid, toUserId: uuid, amountCents: cents,
}).strict().openapi('CreateBudgetSettlement');

const groupParams = z.object({ groupId: uuid.openapi({ param: { name: 'groupId', in: 'path' } }) });
const codeParams = z.object({
  code: z.string().regex(/^[A-Za-z2-9]{8}$/).openapi({ param: { name: 'code', in: 'path' } }),
});

// MARK: Route helpers

const errorCodes = {
  400: 'Invalid request', 401: 'Invalid or missing token', 403: 'Not allowed, or a signed-in Hearth account is required',
  404: 'Not found, or not a member', 409: 'Conflicts with the current state or a limit', 503: 'Storage unavailable',
} as const;
const errors = Object.fromEntries(Object.entries(errorCodes).map(([code, description]) => [
  code, { description, content: { 'application/json': { schema: errorSchema } } },
]));
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { 'application/json': { schema } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { required: true, content: { 'application/json': { schema } } } });
const noContent = { 204: { description: 'Done' } };
const route = <R extends Omit<RouteConfig, 'tags' | 'security'>>(config: R) =>
  createRoute({ ...config, tags: ['Suffice group budgets'], security: [{ BearerAuth: [] }] } as R & { tags: string[] });

export type BudgetGroupsDependencies = {
  service: BudgetGroupsService | undefined;
  /** Checks Suffice access before creating a group (never for joining). Lets everyone through when not given. */
  requireAccess?: EntitlementGate;
};
const needsPlan = { 402: json(errorSchema, 'Needs Suffice Plus or Hearth+ (only when ENFORCE_ENTITLEMENTS is on)') };

const prefix = '/v1/budget-groups';
/** POSTs that carry no body. */
const bodyless = /^\/v1\/budget-groups\/[^/]+\/(leave|invite-code)$/;

export function registerBudgetGroups(app: OpenAPIHono<ApiEnvironment>, dependencies: BudgetGroupsDependencies) {
  const service = () => {
    if (!dependencies.service) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Group budgets are not configured');
    return dependencies.service;
  };

  app.use(`${prefix}/*`, async (context, next) => {
    if (context.get('isAnonymous')) {
      throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to use group budgets');
    }
    const hasBody = ['POST', 'PATCH'].includes(context.req.method) && !bodyless.test(context.req.path);
    if (hasBody && context.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      throw new ApiError(400, 'INVALID_REQUEST', 'An application/json body is required');
    }
    await next();
  });
  // The batch upload carries a whole household budget's history; everything else is small.
  const isBatch = (path: string) => /^\/v1\/budget-groups\/[^/]+\/expenses\/batch$/.test(path);
  app.use(`${prefix}/*`, async (context, next) => bodyLimit({
    maxSize: isBatch(context.req.path) ? 2_000_000 : 64_000,
    onError: () => { throw new ApiError(400, 'INVALID_REQUEST', 'Request body is too large'); },
  })(context, next));

  const me = (context: { get: (key: 'userId') => string }) => context.get('userId');
  const requireAccess = dependencies.requireAccess ?? allowAll;

  // MARK: Invites (before /{groupId} so the paths read in order; they don't overlap)

  app.openapi(route({
    method: 'get', path: `${prefix}/invites/{code}`, summary: 'What an invite code joins',
    request: { params: codeParams },
    responses: { 200: json(invitePreviewSchema, 'Invite preview'), ...errors },
  }), async (context) => context.json(await service().previewInvite(me(context), context.req.valid('param').code), 200));

  app.openapi(route({
    method: 'post', path: `${prefix}/invites/{code}/join`,
    summary: 'Join with an invite code (free: no plan needed). Joining again updates your display name and household key',
    request: { params: codeParams, ...body(joinBody) },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(
    await service().join(me(context), context.req.valid('param').code, context.req.valid('json')), 200,
  ));

  // MARK: Groups

  app.openapi(route({
    method: 'get', path: prefix, summary: 'The group budgets the caller belongs to',
    responses: { 200: json(z.object({ groups: z.array(summarySchema) }), 'Groups, most recently changed first'), ...errors },
  }), async (context) => context.json({ groups: await service().listGroups(me(context)) }, 200));

  app.openapi(route({
    method: 'post', path: prefix, summary: `Create a group budget (Suffice Plus or Hearth+; up to ${BUDGET_LIMITS.ownedGroupsPerUser} owned)`,
    request: body(createGroupBody),
    responses: { 201: json(groupSchema, 'The new group'), ...errors, ...needsPlan },
  }), async (context) => {
    await requireAccess(me(context), 'suffice');
    return context.json(await service().createGroup(me(context), context.req.valid('json')), 201);
  });

  app.openapi(route({
    method: 'get', path: `${prefix}/{groupId}`, summary: 'One group, with its members, expenses and settlements',
    request: { params: groupParams },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(await service().getGroup(me(context), context.req.valid('param').groupId), 200));

  app.openapi(route({
    method: 'patch', path: `${prefix}/{groupId}`, summary: 'Rename the group, or change its plan or dates (owner). null clears a date',
    request: { params: groupParams, ...body(patchGroupBody) },
    responses: { 200: json(groupSchema, 'The group'), ...errors },
  }), async (context) => context.json(
    await service().updateGroup(me(context), context.req.valid('param').groupId, context.req.valid('json')), 200,
  ));

  app.openapi(route({
    method: 'delete', path: `${prefix}/{groupId}`, summary: 'Erase the group and everything in it, for everyone (owner)',
    request: { params: groupParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    await service().deleteGroup(me(context), context.req.valid('param').groupId);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/{groupId}/leave`,
    summary: 'Leave the group. Your expenses and any settlements to or from you are removed. The owner deletes instead',
    request: { params: groupParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    await service().leave(me(context), context.req.valid('param').groupId);
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'delete', path: `${prefix}/{groupId}/members/{userId}`,
    summary: 'Remove someone (owner), with their expenses and settlements. Your own id leaves',
    request: { params: groupParams.extend({ userId: uuid.openapi({ param: { name: 'userId', in: 'path' } }) }) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, userId } = context.req.valid('param');
    await service().removeMember(me(context), groupId, userId.toLowerCase());
    return context.body(null, 204);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/{groupId}/invite-code`, summary: 'Replace the invite code; the old one stops working (owner)',
    request: { params: groupParams },
    responses: { 200: json(inviteSchema, 'The new invite'), ...errors },
  }), async (context) => context.json(await service().rotateInvite(me(context), context.req.valid('param').groupId), 200));

  // MARK: Expenses

  const expenseParams = groupParams.extend({ expenseId: uuid.openapi({ param: { name: 'expenseId', in: 'path' } }) });

  app.openapi(route({
    method: 'post', path: `${prefix}/{groupId}/expenses`,
    summary: `Add an expense you paid. Repeating a clientId returns the first one with 200 (up to ${BUDGET_LIMITS.expensesPerGroup} per group)`,
    request: { params: groupParams, ...body(expenseBody) },
    responses: { 201: json(expenseSchema, 'The new expense'), 200: json(expenseSchema, 'Already added'), ...errors },
  }), async (context) => {
    const { expense, created } = await service().addExpense(me(context), context.req.valid('param').groupId, context.req.valid('json'));
    return created ? context.json(expense, 201) : context.json(expense, 200);
  });

  app.openapi(route({
    method: 'post', path: `${prefix}/{groupId}/expenses/batch`,
    summary: 'Add many expenses you paid at once (a household budget becoming a group). Each clientId is added once',
    request: { params: groupParams, ...body(batchBody) },
    responses: { 200: json(z.object({ expenses: z.array(expenseSchema) }), 'The expenses, in the order sent'), ...errors },
  }), async (context) => context.json({
    expenses: await service().addExpenses(me(context), context.req.valid('param').groupId, context.req.valid('json').expenses),
  }, 200));

  app.openapi(route({
    method: 'patch', path: `${prefix}/{groupId}/expenses/{expenseId}`, summary: 'Change an expense (whoever added it). null clears the note',
    request: { params: expenseParams, ...body(patchExpenseBody) },
    responses: { 200: json(expenseSchema, 'The expense'), ...errors },
  }), async (context) => {
    const { groupId, expenseId } = context.req.valid('param');
    return context.json(await service().updateExpense(me(context), groupId, expenseId, context.req.valid('json')), 200);
  });

  app.openapi(route({
    method: 'delete', path: `${prefix}/{groupId}/expenses/{expenseId}`, summary: 'Delete an expense (whoever added it, or the owner)',
    request: { params: expenseParams },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, expenseId } = context.req.valid('param');
    await service().deleteExpense(me(context), groupId, expenseId);
    return context.body(null, 204);
  });

  // MARK: Settlements

  app.openapi(route({
    method: 'post', path: `${prefix}/{groupId}/settlements`,
    summary: 'Record a payment between two members (settle up). Repeating a clientId returns the first one with 200',
    request: { params: groupParams, ...body(settlementBody) },
    responses: { 201: json(settlementSchema, 'The new settlement'), 200: json(settlementSchema, 'Already recorded'), ...errors },
  }), async (context) => {
    const { settlement, created } = await service().addSettlement(
      me(context), context.req.valid('param').groupId, context.req.valid('json'),
    );
    return created ? context.json(settlement, 201) : context.json(settlement, 200);
  });

  app.openapi(route({
    method: 'delete', path: `${prefix}/{groupId}/settlements/{settlementId}`,
    summary: 'Delete a settlement (whoever recorded it, or the owner)',
    request: { params: groupParams.extend({ settlementId: uuid.openapi({ param: { name: 'settlementId', in: 'path' } }) }) },
    responses: { ...noContent, ...errors },
  }), async (context) => {
    const { groupId, settlementId } = context.req.valid('param');
    await service().deleteSettlement(me(context), groupId, settlementId);
    return context.body(null, 204);
  });

  // MARK: Invite links

  // iOS opens /suffice/join/<code> in Suffice (apple-app-site-association). Without the app, explain.
  app.get('/suffice/join/:code', async (context) => {
    const code = context.req.param('code').toUpperCase();
    const safe = /^[A-Z2-9]{8}$/.test(code) ? code : '';
    let name: string | null = null;
    if (safe && dependencies.service) {
      try {
        name = await dependencies.service.inviteGroupName(safe);
      } catch {
        // The page still explains what to do without the name.
      }
    }
    return context.html(joinPage(safe, name), 200);
  });
}

const escapeHTML = (value: string) => value.replace(/[&<>"']/g, (character) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character
));

const joinPage = (code: string, name: string | null) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Join a group budget in Suffice</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh;
         display: grid; place-items: center; text-align: center; padding: 24px; box-sizing: border-box; }
  h1 { font-size: 24px; margin: 0 0 8px; }
  h2 { font-size: 20px; margin: 0 0 16px; }
  p { margin: 0 auto 16px; opacity: 0.75; max-width: 22rem; }
  .code { font: 600 28px ui-monospace, SFMono-Regular, monospace; letter-spacing: 4px; margin: 8px 0 20px; }
  .note { font-size: 14px; }
</style>
</head>
<body>
<main>
<h1>You're invited to a group budget in Suffice</h1>
${name ? `<h2>${escapeHTML(name)}</h2>` : ''}
<p>Open this link on an iPhone or iPad with Suffice installed${code ? ', or enter this code in Suffice under Group Budgets › Join' : ''}.</p>
${code ? `<div class="code">${code}</div>` : ''}
<p class="note">Group budgets are stored on Hearth's servers so everyone in the group can see them: the group's name and plan, members' display names, and the expenses and payments members add. Never bank data. Everything else in Suffice stays in your iCloud.</p>
</main>
</body>
</html>`;
