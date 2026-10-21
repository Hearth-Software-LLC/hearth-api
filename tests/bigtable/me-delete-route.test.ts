import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";
import type { AccountDeletionDependencies } from "../../src/services/account-deletion.js";
import type { HearkenService } from "../../src/hearken/service.js";
import type { ConnectionStore } from "../../src/services/connections.js";
import type { PlaidDataClient } from "../../src/integrations/plaid.js";

const getUserIdFromAuthHeader = vi.fn();
const insertNotification = vi.fn();
const deleteRevenueCatSubscriber = vi.fn();
const fromMock = vi.fn();
const deleteUserMock = vi.fn();
const listStorageMock = vi.fn();
const removeStorageMock = vi.fn();
const deletePushTokensMock = vi.fn();

let managedMemberExists = false;
let membershipOrganizerId: string | null = null;
let subscriptionTier: "free" | "pro" = "free";

const supabaseAdmin = {
  from: fromMock,
  storage: {
    from: vi.fn(() => ({
      list: listStorageMock,
      remove: removeStorageMock,
    })),
  },
  auth: {
    admin: {
      deleteUser: deleteUserMock,
    },
  },
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/notifications.js", () => ({
  insertNotification,
}));

vi.mock("../../src/services/revenuecat.js", () => ({
  ensureRevenueCatSubscriber: vi.fn(),
  deleteRevenueCatSubscriber,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createHouseholdMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string) => {
        if (column === "organizer_id") {
          return {
            limit: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: managedMemberExists ? { member_id: "member-1" } : null,
                error: null,
              })),
            })),
          };
        }

        return {
          maybeSingle: vi.fn(async () => ({
            data: membershipOrganizerId ? { organizer_id: membershipOrganizerId } : null,
            error: null,
          })),
        };
      }),
    })),
  };
}

function createSubscriptionsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            tier: subscriptionTier,
            revenuecat_user_id: "rc-user-1",
          },
          error: null,
        })),
      })),
    })),
  };
}

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: { id: "user-1", household_name: "Member Household" },
          error: null,
        })),
      })),
    })),
  };
}

describe("DELETE /api/me", () => {
  // Imported lazily: the module under test imports the mocked modules above.
  async function setAccountDeletionDependencies(dependencies: AccountDeletionDependencies) {
    (await import("../../src/services/account-deletion.js")).setAccountDeletionDependencies(dependencies);
  }

  beforeEach(async () => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    managedMemberExists = false;
    membershipOrganizerId = null;
    subscriptionTier = "free";

    listStorageMock.mockResolvedValue({ data: [], error: null });
    removeStorageMock.mockResolvedValue({ error: null });
    deleteUserMock.mockResolvedValue({ error: null });
    supabaseAdmin.storage.from.mockImplementation(() => ({
      list: listStorageMock,
      remove: removeStorageMock,
    }));

    fromMock.mockImplementation((table: string) => {
      if (table === "household_memberships") {
        return createHouseholdMembershipsTableMock();
      }
      if (table === "subscriptions") {
        return createSubscriptionsTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "push_tokens") {
        return { delete: vi.fn(() => ({ eq: deletePushTokensMock })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    deletePushTokensMock.mockResolvedValue({ error: null });
    await setAccountDeletionDependencies({});
  });

  it("blocks organizer account deletion when active members exist", async () => {
    managedMemberExists = true;

    const { DELETE } = await import("../../src/bigtable/routes/me.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest("http://localhost/api/me", {}, "token", { method: "DELETE" }) as never
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toBe("Remove all household members before deleting your account");
    expect(deleteUserMock).not.toHaveBeenCalled();
  });

  it("notifies organizer when a member deletes their account", async () => {
    membershipOrganizerId = "organizer-1";

    const { DELETE } = await import("../../src/bigtable/routes/me.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest("http://localhost/api/me", {}, "token", { method: "DELETE" }) as never
    );

    expect(response.status).toBe(200);
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({
      recipientProfileId: "organizer-1",
      type: "household_member_left",
    }));
    expect(deleteUserMock).toHaveBeenCalledWith("user-1");
  });

  it("also removes the caller's Hearken data and Plaid connections", async () => {
    const purgeUser = vi.fn().mockResolvedValue(undefined);
    const removeItem = vi.fn().mockResolvedValue({});
    const connections = {
      list: vi.fn().mockResolvedValue([{ itemId: "item-1", institution: "Bank", createdAt: "2026-10-01T00:00:00Z" }]),
      get: vi.fn().mockResolvedValue({ itemId: "item-1", institution: "Bank", sealedToken: "sealed", createdAt: "2026-10-01T00:00:00Z" }),
      remove: vi.fn().mockResolvedValue(undefined),
      save: vi.fn(),
    } satisfies ConnectionStore;
    await setAccountDeletionDependencies({
      hearken: { purgeUser } as unknown as HearkenService,
      connections,
      plaidClient: { removeItem } as unknown as PlaidDataClient,
      seal: { seal: vi.fn(), open: vi.fn(() => "access-token") },
    });

    const { DELETE } = await import("../../src/bigtable/routes/me.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest("http://localhost/api/me", {}, "token", { method: "DELETE" }) as never
    );

    expect(response.status).toBe(200);
    expect(purgeUser).toHaveBeenCalledWith("user-1");
    expect(removeItem).toHaveBeenCalledWith("access-token", expect.any(AbortSignal));
    expect(connections.remove).toHaveBeenCalledWith("user-1", "item-1");
    expect(deletePushTokensMock).toHaveBeenCalledWith("profile_id", "user-1");
    // A free BigTable tier keeps the old behaviour: no RevenueCat call from this route.
    expect(deleteRevenueCatSubscriber).not.toHaveBeenCalled();
    expect(deleteUserMock).toHaveBeenCalledWith("user-1");
  });

  it("keeps the account when Hearken cleanup fails", async () => {
    await setAccountDeletionDependencies({ hearken: { purgeUser: vi.fn().mockRejectedValue(new Error("db down")) } as unknown as HearkenService });

    const { DELETE } = await import("../../src/bigtable/routes/me.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest("http://localhost/api/me", {}, "token", { method: "DELETE" }) as never
    );

    expect(response.status).toBe(500);
    expect(deleteUserMock).not.toHaveBeenCalled();
  });
});
