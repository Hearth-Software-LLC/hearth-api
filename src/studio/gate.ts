import type { Context, MiddlewareHandler } from 'hono';
import type { ApiEnvironment } from '../contracts/common.js';
import { ApiError } from '../errors.js';
import { can } from './team.js';
import type { Member, Permission, TeamService } from './team.js';

/**
 * Studio routes run as the caller's team. The middleware finds the caller's membership once per
 * request (kept on the context: body limits swap the raw Request); handlers then ask for the team (`teamOf`) and check permissions (`need`).
 */
export function studioMiddleware(team: () => TeamService | undefined): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const service = team();
    if (!service) throw new ApiError(503, 'STORAGE_NOT_CONFIGURED', 'Hearth Studio is not configured (DATABASE_URL)');
    if (context.get('isAnonymous')) throw new ApiError(403, 'REGISTERED_IDENTITY_REQUIRED', 'Sign in with Apple to use Hearth Studio');
    const member = await service.memberOf(context.get('userId'));
    if (!member) {
      throw new ApiError(403, 'NOT_ON_TEAM', 'This account isn’t on the Hearth Software team. Ask Steve for an invite.');
    }
    context.set('studioMember', member);
    await next();
  };
}

type AnyContext = Pick<Context<ApiEnvironment>, 'get'>;

export function memberOf(context: AnyContext): Member {
  const member = context.get('studioMember');
  if (!member) throw new ApiError(403, 'NOT_ON_TEAM', 'This account isn’t on the Hearth Software team');
  return member;
}

export const teamOf = (context: AnyContext) => memberOf(context).teamId;

const what: Record<Permission, string> = {
  post: 'post and reply',
  plans: 'grant plans',
  accounts: 'connect social accounts',
  affiliates: 'manage affiliates and payouts',
  owner: 'manage the team',
};

export function need(context: AnyContext, permission: Permission): Member {
  const member = memberOf(context);
  if (!can(member, permission)) {
    throw new ApiError(403, 'PERMISSION_REQUIRED', `Your place on the team doesn’t let you ${what[permission]}. Ask Steve to turn it on.`);
  }
  return member;
}
