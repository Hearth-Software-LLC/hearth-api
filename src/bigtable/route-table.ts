// Generated from the BigTable Next.js route files: one entry per exported handler.
// Paths use OpenAPI-style {param} segments; register.ts converts them for Hono.
import * as aiGroceryListRoute from './routes/ai.grocery-list.js';
import * as aiMealPlanRoute from './routes/ai.meal-plan.js';
import * as aiRecipeAudioRoute from './routes/ai.recipe-audio.js';
import * as aiRecipeImageRoute from './routes/ai.recipe-image.js';
import * as aiRecipeScanRoute from './routes/ai.recipe-scan.js';
import * as aiRecipeRefineRoute from './routes/ai.recipe-refine.js';
import * as aiRecipeTranscriptRoute from './routes/ai.recipe-transcript.js';
import * as aiRecipeUrlRoute from './routes/ai.recipe-url.js';
import * as blocksProfileIdRoute from './routes/blocks._profileId.js';
import * as blocksRoute from './routes/blocks.js';
import * as followsRoute from './routes/follows.js';
import * as grocerySnapshotsRoute from './routes/grocery.snapshots.js';
import * as healthRoute from './routes/health.js';
import * as householdInvitationsIdRoute from './routes/household.invitations._id.js';
import * as householdInvitationsRoute from './routes/household.invitations.js';
import * as householdJoinCodeRoute from './routes/household.join-code.js';
import * as householdJoinRoute from './routes/household.join.js';
import * as householdMembersMemberIdPermissionsRoute from './routes/household.members._memberId.permissions.js';
import * as householdMembersMemberIdRoute from './routes/household.members._memberId.js';
import * as inviteRoute from './routes/invite.js';
import * as maestroResetRoute from './routes/maestro.reset.js';
import * as meKitchenExportRoute from './routes/me.kitchen-export.js';
import * as meKitchenMovedRoute from './routes/me.kitchen-moved.js';
import * as meNotificationPrefsRoute from './routes/me.notification-prefs.js';
import * as mePublicProfileRoute from './routes/me.public-profile.js';
import * as meSocialVisibilityRoute from './routes/me.social-visibility.js';
import * as meRoute from './routes/me.js';
import * as notificationsRoute from './routes/notifications.js';
import * as notificationsUnreadCountRoute from './routes/notifications.unread-count.js';
import * as placesSearchRoute from './routes/places.search.js';
import * as plansCurrentRoute from './routes/plans.current.js';
import * as profilesIdPublicRoute from './routes/profiles._id.public.js';
import * as pushTokensRoute from './routes/push-tokens.js';
import * as recipesIdLikeRoute from './routes/recipes._id.like.js';
import * as recipesIdOgRoute from './routes/recipes._id.og.js';
import * as recipesIdPublicationRoute from './routes/recipes._id.publication.js';
import * as recipesIdPublishRoute from './routes/recipes._id.publish.js';
import * as recipesIdRestoreRoute from './routes/recipes._id.restore.js';
import * as recipesIdRoute from './routes/recipes._id.js';
import * as recipesIdUnpublishRoute from './routes/recipes._id.unpublish.js';
import * as recipesFavoritesRoute from './routes/recipes.favorites.js';
import * as recipesTagsIdRoute from './routes/recipes.tags._id.js';
import * as recipesTagsRoute from './routes/recipes.tags.js';
import * as recipesRoute from './routes/recipes.js';
import * as usageCheckRoute from './routes/usage.check.js';
import * as webhooksRevenuecatRoute from './routes/webhooks.revenuecat.js';

// Path parameters by name. Each handler reads only the ones its own path declares.
export type BigTableParams = Record<'id' | 'memberId' | 'profileId', string> & Record<string, string>;

export type BigTableHandler = (
  request: Request,
  context: { params: Promise<BigTableParams> },
) => Promise<Response> | Response;

export type BigTableRoute = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  handler: BigTableHandler;
  // Whether the handler requires a signed-in (non-anonymous) user. Handlers enforce it
  // themselves; this flag drives the OpenAPI security annotation.
  auth: boolean;
};

export const bigTableRoutes: BigTableRoute[] = [
  { method: 'POST', path: '/v1/bigtable/ai/grocery-list', handler: aiGroceryListRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/meal-plan', handler: aiMealPlanRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-audio', handler: aiRecipeAudioRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-image', handler: aiRecipeImageRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-refine', handler: aiRecipeRefineRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-scan', handler: aiRecipeScanRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-transcript', handler: aiRecipeTranscriptRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/ai/recipe-url', handler: aiRecipeUrlRoute.POST, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/blocks/{profileId}', handler: blocksProfileIdRoute.DELETE, auth: true },
  { method: 'GET', path: '/v1/bigtable/blocks', handler: blocksRoute.GET, auth: true },
  { method: 'POST', path: '/v1/bigtable/blocks', handler: blocksRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/follows', handler: followsRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/follows', handler: followsRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/grocery/snapshots', handler: grocerySnapshotsRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/grocery/snapshots', handler: grocerySnapshotsRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/health', handler: healthRoute.GET, auth: false },
  { method: 'PUT', path: '/v1/bigtable/household/invitations/{id}', handler: householdInvitationsIdRoute.PUT, auth: true },
  { method: 'POST', path: '/v1/bigtable/household/invitations', handler: householdInvitationsRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/household/invitations', handler: householdInvitationsRoute.GET, auth: true },
  { method: 'POST', path: '/v1/bigtable/household/join-code', handler: householdJoinCodeRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/household/join', handler: householdJoinRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/household/members/{memberId}/permissions', handler: householdMembersMemberIdPermissionsRoute.GET, auth: true },
  { method: 'PATCH', path: '/v1/bigtable/household/members/{memberId}/permissions', handler: householdMembersMemberIdPermissionsRoute.PATCH, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/household/members/{memberId}', handler: householdMembersMemberIdRoute.DELETE, auth: true },
  { method: 'POST', path: '/v1/bigtable/invite', handler: inviteRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/maestro/reset', handler: maestroResetRoute.POST, auth: false },
  { method: 'GET', path: '/v1/bigtable/me/kitchen-export', handler: meKitchenExportRoute.GET, auth: true },
  { method: 'POST', path: '/v1/bigtable/me/kitchen-moved', handler: meKitchenMovedRoute.POST, auth: true },
  { method: 'PUT', path: '/v1/bigtable/me/public-profile', handler: mePublicProfileRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/me/notification-prefs', handler: meNotificationPrefsRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/me/notification-prefs', handler: meNotificationPrefsRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/me/social-visibility', handler: meSocialVisibilityRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/me/social-visibility', handler: meSocialVisibilityRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/me', handler: meRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/me', handler: meRoute.PUT, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/me', handler: meRoute.DELETE, auth: true },
  { method: 'PATCH', path: '/v1/bigtable/me', handler: meRoute.PATCH, auth: true },
  { method: 'GET', path: '/v1/bigtable/notifications', handler: notificationsRoute.GET, auth: true },
  { method: 'PATCH', path: '/v1/bigtable/notifications', handler: notificationsRoute.PATCH, auth: true },
  { method: 'GET', path: '/v1/bigtable/notifications/unread-count', handler: notificationsUnreadCountRoute.GET, auth: true },
  { method: 'GET', path: '/v1/bigtable/places/search', handler: placesSearchRoute.GET, auth: true },
  { method: 'GET', path: '/v1/bigtable/plans/current', handler: plansCurrentRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/plans/current', handler: plansCurrentRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/profiles/{id}/public', handler: profilesIdPublicRoute.GET, auth: true },
  { method: 'GET', path: '/v1/bigtable/push-tokens', handler: pushTokensRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/push-tokens', handler: pushTokensRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes/{id}/like', handler: recipesIdLikeRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/recipes/{id}/like', handler: recipesIdLikeRoute.PUT, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes/{id}/og', handler: recipesIdOgRoute.GET, auth: false },
  { method: 'PUT', path: '/v1/bigtable/recipes/{id}/publication', handler: recipesIdPublicationRoute.PUT, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/recipes/{id}/publication', handler: recipesIdPublicationRoute.DELETE, auth: true },
  { method: 'POST', path: '/v1/bigtable/recipes/{id}/publish', handler: recipesIdPublishRoute.POST, auth: true },
  { method: 'POST', path: '/v1/bigtable/recipes/{id}/restore', handler: recipesIdRestoreRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes/{id}', handler: recipesIdRoute.GET, auth: true },
  { method: 'PATCH', path: '/v1/bigtable/recipes/{id}', handler: recipesIdRoute.PATCH, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/recipes/{id}', handler: recipesIdRoute.DELETE, auth: true },
  { method: 'POST', path: '/v1/bigtable/recipes/{id}/unpublish', handler: recipesIdUnpublishRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes/favorites', handler: recipesFavoritesRoute.GET, auth: true },
  { method: 'PUT', path: '/v1/bigtable/recipes/favorites', handler: recipesFavoritesRoute.PUT, auth: true },
  { method: 'PATCH', path: '/v1/bigtable/recipes/tags/{id}', handler: recipesTagsIdRoute.PATCH, auth: true },
  { method: 'DELETE', path: '/v1/bigtable/recipes/tags/{id}', handler: recipesTagsIdRoute.DELETE, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes/tags', handler: recipesTagsRoute.GET, auth: true },
  { method: 'POST', path: '/v1/bigtable/recipes/tags', handler: recipesTagsRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/recipes', handler: recipesRoute.GET, auth: true },
  { method: 'POST', path: '/v1/bigtable/recipes', handler: recipesRoute.POST, auth: true },
  { method: 'GET', path: '/v1/bigtable/usage/check', handler: usageCheckRoute.GET, auth: true },
  { method: 'POST', path: '/webhooks/revenuecat', handler: webhooksRevenuecatRoute.POST, auth: false },
];
