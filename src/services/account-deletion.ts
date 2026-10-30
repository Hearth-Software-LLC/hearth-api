import { ApiError } from '../errors.js';
import type { HearkenService } from '../hearken/service.js';
import type { BudgetGroupsService } from '../budget-groups/service.js';
import { isPlaidCode, plaidFailure } from '../integrations/plaid.js';
import type { PlaidDataClient } from '../integrations/plaid.js';
import { insertNotification } from '../bigtable/lib/notifications.js';
import { deleteRevenueCatSubscriber } from './revenuecat.js';
import { supabaseAdmin } from './supabase.js';
import type { ConnectionStore } from './connections.js';
import type { ReportStore } from './reports.js';
import type { TokenSeal } from './token-seal.js';

/**
 * Deleting a Hearth account, for every app at once. Used by DELETE /v1/me and, so that a BigTable
 * account deletion also leaves nothing behind in the other apps, by DELETE /v1/bigtable/me.
 *
 * Order: BigTable's checks (nothing is deleted while the caller still runs a household with other
 * people in it), BigTable's own cleanup, Hearken, Suffice's group budgets and bank connections,
 * RevenueCat, push tokens, and last the auth user, whose foreign keys take the rest of BigTable's
 * rows with it. Hearken's and the group budgets' tables and plaid_connections have no foreign key
 * to auth.users, so they're deleted here explicitly. Every step can run again, so a failed deletion can simply be retried.
 */

export type AccountDeletionDependencies = {
  plaidClient?: PlaidDataClient | undefined;
  connections?: ConnectionStore | undefined;
  seal?: TokenSeal | undefined;
  hearken?: HearkenService | undefined;
  budgetGroups?: Pick<BudgetGroupsService, 'purgeUser'> | undefined;
  reports?: ReportStore | undefined;
  /** Hearth Content: the person's Collection ratings and reports. */
  collections?: { forgetUser: (userId: string) => Promise<void> } | undefined;
  /** Ends an affiliate's own sign-in (their credit and payouts are the team's records and stay). */
  affiliates?: { forgetUser: (userId: string) => Promise<void> } | undefined;
};

// Set by createApp. The BigTable handlers are plain functions without the app's dependencies,
// so they reach Plaid and Hearken through here (the same way they get the token verifier).
let dependencies: AccountDeletionDependencies = {};

export function setAccountDeletionDependencies(next: AccountDeletionDependencies) {
  dependencies = next;
}

/** A step failed. `message` is safe to show; `failure` is logged. */
export class AccountDeletionError extends Error {
  constructor(
    public readonly step: string,
    message: string,
    public readonly failure: unknown,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export type DeleteAccountOptions = {
  /**
   * `paid-tier`: delete the RevenueCat customer only when BigTable's subscription tier is paid
   * (DELETE /v1/bigtable/me, as before). `always`: whatever the tier (DELETE /v1/me), since the
   * other apps' plans and Hearth+ live on the same RevenueCat customer.
   */
  revenueCat: 'paid-tier' | 'always';
};

export type DeleteAccountResult = 'deleted' | 'household_has_members';

function displayNameFromProfile(profile: { household_name?: string | null } | null | undefined, fallback = 'A member') {
  const name = typeof profile?.household_name === 'string' ? profile.household_name.trim() : '';
  return name || fallback;
}

async function deleteMemberAvatarObjects(profileId: string) {
  const bucket = supabaseAdmin.storage.from('member-avatars');
  const { data: listedObjects, error: listError } = await bucket.list(profileId, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  });
  if (listError) throw listError;

  const objectPaths = (listedObjects ?? [])
    .filter((entry) => Boolean(entry.name))
    .map((entry) => `${profileId}/${entry.name}`);
  if (objectPaths.length === 0) return;

  const { error: removeError } = await bucket.remove(objectPaths);
  if (removeError) throw removeError;
}

/** Plaid forgets each of the person's banks, then the API forgets the connection. */
async function removeBankConnections(userId: string) {
  const { plaidClient, connections, seal } = dependencies;
  // Without connection storage there's nothing stored to remove.
  if (!connections) return;
  const stored = await connections.list(userId);
  if (stored.length === 0) return;
  if (!plaidClient || !seal) {
    throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', 'Your bank connections can’t be removed right now. Try again later.');
  }
  for (const { itemId } of stored) {
    const connection = await connections.get(userId, itemId);
    let accessToken: string | undefined;
    if (connection) {
      try {
        accessToken = seal.open(connection.sealedToken, userId, itemId);
      } catch {
        // A token that no longer opens can't be used at Plaid by anyone; forget the row anyway.
        console.warn('Account deletion: a Plaid access token could not be opened; removing the connection row only', { itemId });
      }
    }
    if (accessToken) {
      const signal = AbortSignal.timeout(8000);
      try {
        await plaidClient.removeItem(accessToken, signal);
      } catch (error) {
        // Already gone at Plaid: still forget it here.
        if (!isPlaidCode(error, ['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN'])) {
          const failure = plaidFailure(error, signal);
          // Keep 409 for "household has members": anything else Plaid says is an upstream failure here.
          throw failure.status >= 500
            ? failure
            : new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'Plaid couldn’t remove a bank connection. Try again later.');
        }
      }
    }
    await connections.remove(userId, itemId);
  }
}

async function detachSetNullRows(userId: string) {
  const drafts = await supabaseAdmin
    .from('recipes')
    .delete()
    .eq('created_by_profile_id', userId)
    .neq('status', 'published');
  if (drafts.error) throw drafts.error;

  const steps = [
    supabaseAdmin.from('recipes').update({ created_by_profile_id: null }).eq('created_by_profile_id', userId),
    supabaseAdmin.from('notifications').update({ actor_profile_id: null }).eq('actor_profile_id', userId),
    supabaseAdmin.from('revenuecat_webhook_events').update({ profile_id: null }).eq('profile_id', userId),
  ];
  for (const step of steps) {
    const { error } = await step;
    if (error) throw error;
  }
}

function revenueCatConfigured() {
  return Boolean(process.env.REVENUECAT_SECRET_API_KEY?.trim() && process.env.REVENUECAT_PROJECT_ID?.trim());
}

/**
 * Deletes the caller's Hearth account and everything kept about them, or returns
 * `household_has_members` (nothing deleted) when they still run a BigTable household with other
 * people in it. Throws AccountDeletionError, or an ApiError from Plaid, when a step fails.
 */
export async function deleteHearthAccount(userId: string, options: DeleteAccountOptions): Promise<DeleteAccountResult> {
  // 1. BigTable's checks.
  const [managedMembersResult, membershipResult] = await Promise.all([
    supabaseAdmin
      .from('household_memberships')
      .select('member_id')
      .eq('organizer_id', userId)
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('household_memberships')
      .select('organizer_id')
      .eq('member_id', userId)
      .maybeSingle(),
  ]);
  if (managedMembersResult.error || membershipResult.error) {
    throw new AccountDeletionError('membership checks', 'Failed to delete account', managedMembersResult.error ?? membershipResult.error);
  }
  if (managedMembersResult.data) return 'household_has_members';

  const subscriptionResult = await supabaseAdmin
    .from('subscriptions')
    .select('tier, revenuecat_user_id')
    .eq('profile_id', userId)
    .maybeSingle();
  if (subscriptionResult.error) {
    throw new AccountDeletionError('subscription lookup', 'Failed to delete account', subscriptionResult.error);
  }

  // 2. BigTable's own cleanup: storage objects aren't covered by the auth user's foreign keys.
  try {
    await deleteMemberAvatarObjects(userId);
  } catch (error) {
    throw new AccountDeletionError('delete member avatars', 'Failed to delete account', error);
  }

  // 3. Hearken: groups pass to another member; what the person wrote, their blocks and their reports go now.
  if (dependencies.hearken) {
    try {
      await dependencies.hearken.purgeUser(userId);
    } catch (error) {
      throw new AccountDeletionError('hearken cleanup', 'Failed to delete your study group data', error);
    }
  }
  if (dependencies.reports) {
    try {
      await dependencies.reports.removeByReporter(userId);
    } catch (error) {
      throw new AccountDeletionError('reports cleanup', 'Failed to delete account', error);
    }
  }

  if (dependencies.collections) {
    try {
      await dependencies.collections.forgetUser(userId);
    } catch (error) {
      throw new AccountDeletionError('collections cleanup', 'Failed to delete account', error);
    }
  }

  if (dependencies.affiliates) {
    try {
      await dependencies.affiliates.forgetUser(userId);
    } catch (error) {
      throw new AccountDeletionError('affiliate cleanup', 'Failed to delete account', error);
    }
  }

  // 4. Suffice: group budgets the person owns are erased for everyone; elsewhere they leave, taking
  // their expenses and settlements. Then the banks connected through Plaid.
  if (dependencies.budgetGroups) {
    try {
      await dependencies.budgetGroups.purgeUser(userId);
    } catch (error) {
      throw new AccountDeletionError('budget groups cleanup', 'Failed to delete your group budget data', error);
    }
  }
  await removeBankConnections(userId);

  // 5. RevenueCat. Deleting an unknown customer is a success (404).
  const revenueCatUserId = (subscriptionResult.data?.revenuecat_user_id as string | null | undefined)?.trim() || userId;
  const tier = subscriptionResult.data?.tier as string | null | undefined;
  const hasPaidTier = Boolean(tier && tier !== 'free');
  // Without RevenueCat configured (local development), only a paid tier makes that a failure.
  const deleteCustomer = hasPaidTier || (options.revenueCat === 'always' && revenueCatConfigured());
  if (deleteCustomer) {
    try {
      await deleteRevenueCatSubscriber(revenueCatUserId);
    } catch (error) {
      throw new AccountDeletionError('revenuecat cancellation', 'Failed to cancel subscription during account deletion', error);
    }
  }

  // 6. Push tokens.
  const pushTokensResult = await supabaseAdmin.from('push_tokens').delete().eq('profile_id', userId);
  if (pushTokensResult.error) {
    throw new AccountDeletionError('delete push tokens', 'Failed to delete account', pushTokensResult.error);
  }

  // 7. Rows whose foreign key to the profile is ON DELETE SET NULL. Auth's own database role can't
  // run those updates during the cascade ("permission denied for table recipes"), so the service
  // role does them first and the cascade below only deletes. Unpublished recipes go; published
  // ones stay for the people who saved them, without the author (as the privacy policy says).
  try {
    await detachSetNullRows(userId);
  } catch (error) {
    throw new AccountDeletionError('detach recipes', 'Failed to delete account', error);
  }

  // 8. A household member leaving tells the organizer, then the auth user goes.
  if (membershipResult.data?.organizer_id) {
    const profileResult = await supabaseAdmin
      .from('profiles')
      .select('id, household_name')
      .eq('id', userId)
      .maybeSingle();
    if (profileResult.error) {
      throw new AccountDeletionError('member profile lookup', 'Failed to delete account', profileResult.error);
    }
    await insertNotification({
      recipientProfileId: membershipResult.data.organizer_id as string,
      type: 'household_member_left',
      actorProfileId: userId,
      data: {
        memberProfileId: userId,
        memberName: displayNameFromProfile(profileResult.data as { household_name?: string | null } | null, 'A member'),
      },
    });
  }

  const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (deleteUserError) {
    throw new AccountDeletionError('delete user', 'Failed to delete account', deleteUserError);
  }
  return 'deleted';
}

/** An anonymous session has nothing but its auth user. */
export async function deleteAnonymousAccount(userId: string) {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) throw new AccountDeletionError('delete user', 'Failed to delete account', error);
}
