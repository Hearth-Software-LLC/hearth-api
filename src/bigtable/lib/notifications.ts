import { supabaseAdmin } from "../../services/supabase.js";

export type NotificationType =
  | "recipe_published"
  | "recipe_updated"
  | "recipe_liked"
  | "recipe_saved"
  | "new_follower"
  | "household_invitation"
  | "household_invitation_accepted"
  | "household_invitation_declined"
  | "household_member_removed"
  | "household_member_left"
  | "household_member_permissions_changed";

type BaseNotificationInsert = {
  recipientProfileId: string;
  type: NotificationType;
  actorProfileId?: string | null;
  recipeId?: string | null;
  versionId?: string | null;
  data?: Record<string, unknown> | undefined;
};

type NotificationPrefs = Partial<Record<NotificationType, boolean>>;
const NOTIFICATION_NAME_LIMIT = 30;

function truncateNotificationLabel(value: unknown, fallback: string) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.length <= NOTIFICATION_NAME_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, NOTIFICATION_NAME_LIMIT - 3)}...`;
}

function shouldSendPushForType(type: NotificationType) {
  return [
    "new_follower",
    "recipe_published",
    "recipe_updated",
    "household_invitation",
    "household_invitation_accepted",
    "household_invitation_declined",
    "household_member_removed",
    "household_member_permissions_changed",
  ].includes(type);
}

function pushMessageForNotification(input: {
  type: NotificationType;
  data?: Record<string, unknown> | undefined;
}) {
  if (input.type === "new_follower") {
    return {
      title: "New follower",
      body: "Someone started following you",
    };
  }

  if (input.type === "recipe_published" || input.type === "recipe_updated") {
    const recipeTitle = typeof input.data?.recipeTitle === "string" ? input.data.recipeTitle : "Recipe";
    return {
      title: "Recipe update",
      body: `${recipeTitle} is now available`,
    };
  }

  if (input.type === "household_invitation") {
    const organizerName = truncateNotificationLabel(input.data?.organizerHouseholdName, "Someone");
    return {
      title: "Household invitation",
      body: `${organizerName} has invited you to join their household on BigTable.`,
    };
  }

  if (input.type === "household_invitation_accepted") {
    const memberName = truncateNotificationLabel(input.data?.memberName, "A member");
    return {
      title: "Invitation accepted",
      body: `${memberName} accepted your household invitation.`,
    };
  }

  if (input.type === "household_invitation_declined") {
    const memberName = truncateNotificationLabel(input.data?.memberName, "A member");
    return {
      title: "Invitation declined",
      body: `${memberName} declined your household invitation.`,
    };
  }

  if (input.type === "household_member_removed") {
    const householdName = truncateNotificationLabel(input.data?.organizerHouseholdName, "your organizer");
    return {
      title: "Removed from household",
      body: `You've been removed from ${householdName}'s household.`,
    };
  }

  if (input.type === "household_member_permissions_changed") {
    return {
      title: "Household access updated",
      body: "Your organizer has changed your household permissions.",
    };
  }

  return {
    title: "Notification",
    body: "You have a new notification",
  };
}

function pushScreenForNotification(type: NotificationType): string {
  if (type === "recipe_published" || type === "recipe_updated" || type === "new_follower") {
    return "notifications";
  }

  if (
    type === "household_invitation"
    || type === "household_invitation_accepted"
    || type === "household_invitation_declined"
    || type === "household_member_removed"
    || type === "household_member_left"
    || type === "household_member_permissions_changed"
  ) {
    return "notifications";
  }

  return "notifications";
}

async function getNotificationPrefs(profileId: string): Promise<NotificationPrefs> {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("notification_prefs")
    .eq("id", profileId)
    .maybeSingle();

  if (error || !data || typeof data.notification_prefs !== "object" || data.notification_prefs === null) {
    return {};
  }

  return data.notification_prefs as NotificationPrefs;
}

function isNotificationEnabled(prefs: NotificationPrefs, type: NotificationType) {
  const configured = prefs[type];
  if (typeof configured === "boolean") {
    return configured;
  }
  return true;
}

async function sendPushForNotification(input: {
  recipientProfileId: string;
  type: NotificationType;
  data?: Record<string, unknown> | undefined;
}) {
  if (!shouldSendPushForType(input.type)) {
    return;
  }

  if (process.env.PUSH_NOTIFICATIONS_PHASE5_ENABLED?.trim().toLowerCase() === "false") {
    return;
  }

  const { data: rows, error } = await supabaseAdmin
    .from("push_tokens")
    .select("token")
    .eq("profile_id", input.recipientProfileId);

  if (error || !rows || rows.length === 0) {
    return;
  }

  const expoTokens = rows
    .map((row) => row.token)
    .filter((token): token is string => typeof token === "string"
      && (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken[")));

  if (expoTokens.length === 0) {
    return;
  }

  const message = pushMessageForNotification({
    type: input.type,
    data: input.data,
  });

  const messages = expoTokens.map((token) => ({
    to: token,
    sound: "default",
    title: message.title,
    body: message.body,
    data: {
      screen: pushScreenForNotification(input.type),
      type: input.type,
      ...input.data,
    },
  }));

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const expoAccessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (expoAccessToken) {
    headers.Authorization = `Bearer ${expoAccessToken}`;
  }

  await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers,
    body: JSON.stringify(messages),
  });
}

export function isSocialNotificationsEnabled() {
  return process.env.SOCIAL_NOTIFICATIONS_PHASE4_ENABLED?.trim().toLowerCase() !== "false";
}

export async function insertNotification(input: BaseNotificationInsert) {
  if (!isSocialNotificationsEnabled()) {
    return;
  }

  const prefs = await getNotificationPrefs(input.recipientProfileId);
  if (!isNotificationEnabled(prefs, input.type)) {
    return;
  }

  await supabaseAdmin
    .from("notifications")
    .insert({
      recipient_profile_id: input.recipientProfileId,
      type: input.type,
      actor_profile_id: input.actorProfileId ?? null,
      recipe_id: input.recipeId ?? null,
      version_id: input.versionId ?? null,
      data: input.data ?? {},
    });

  await sendPushForNotification({
    recipientProfileId: input.recipientProfileId,
    type: input.type,
    data: input.data,
  });
}

export async function fanOutRecipePublishNotification(input: {
  actorProfileId: string;
  recipeId: string;
  versionId: string;
  recipeTitle: string;
  isUpdate: boolean;
}) {
  if (!isSocialNotificationsEnabled()) {
    return;
  }

  const { data: followers, error } = await supabaseAdmin
    .from("follows")
    .select("follower_profile_id")
    .eq("followee_profile_id", input.actorProfileId);

  if (error || !followers || followers.length === 0) {
    return;
  }

  const type: NotificationType = input.isUpdate ? "recipe_updated" : "recipe_published";

  await Promise.all(
    followers.map((row) => insertNotification({
      recipientProfileId: row.follower_profile_id,
      type,
      actorProfileId: input.actorProfileId,
      recipeId: input.recipeId,
      versionId: input.versionId,
      data: {
        recipeTitle: input.recipeTitle,
        isUpdate: input.isUpdate,
      },
    }))
  );
}

export async function notifyRecipeLiked(input: {
  actorProfileId: string;
  recipeId: string;
  recipeTitle: string;
}) {
  if (!isSocialNotificationsEnabled()) {
    return;
  }

  const { data: recipe, error } = await supabaseAdmin
    .from("recipes")
    .select("created_by_profile_id")
    .eq("id", input.recipeId)
    .maybeSingle();

  if (error || !recipe?.created_by_profile_id) {
    return;
  }

  if (recipe.created_by_profile_id === input.actorProfileId) {
    return;
  }

  await insertNotification({
    recipientProfileId: recipe.created_by_profile_id,
    type: "recipe_liked",
    actorProfileId: input.actorProfileId,
    recipeId: input.recipeId,
    data: {
      recipeTitle: input.recipeTitle,
    },
  });
}

export async function notifyNewFollower(input: {
  actorProfileId: string;
  recipientProfileId: string;
}) {
  if (!isSocialNotificationsEnabled()) {
    return;
  }

  if (input.actorProfileId === input.recipientProfileId) {
    return;
  }

  await insertNotification({
    recipientProfileId: input.recipientProfileId,
    type: "new_follower",
    actorProfileId: input.actorProfileId,
  });
}
