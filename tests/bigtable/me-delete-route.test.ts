import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const insertNotification = vi.fn();
const deleteRevenueCatSubscriber = vi.fn();
const fromMock = vi.fn();
const deleteUserMock = vi.fn();
const listStorageMock = vi.fn();
const removeStorageMock = vi.fn();

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

vi.mock("../../src/bigtable/lib/revenuecat.js", () => ({
  ensureRevenueCatSubscriber: vi.fn(),
  deleteRevenueCatSubscriber,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
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
  beforeEach(() => {
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
      throw new Error(`Unexpected table: ${table}`);
    });
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
});
