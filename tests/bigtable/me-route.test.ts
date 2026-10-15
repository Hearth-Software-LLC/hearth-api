import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

let membershipOrganizerId: string | null = null;
let linkedMemberId: string | null = "linked-member-1";

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

vi.mock("../../src/bigtable/lib/revenuecat.js", () => ({
  ensureRevenueCatSubscriber: vi.fn(),
  deleteRevenueCatSubscriber: vi.fn(),
}));

function createMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: membershipOrganizerId ? { organizer_id: membershipOrganizerId } : null,
          error: null,
        })),
      })),
    })),
  };
}

function createProfilesTableMock() {
  return {
    upsert: vi.fn(async () => ({ error: null })),
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            id: membershipOrganizerId ?? "user-1",
            household_name: membershipOrganizerId ? "Organizer Household" : "My Household",
            avatar_url: null,
            created_at: "2026-01-01T00:00:00.000Z",
            social_profile_visible: true,
          },
          error: null,
        })),
      })),
    })),
  };
}

function createHouseholdMembersTableMock() {
  const manualMembers = [{ id: "manual-1" }];
  const linkedMembers = [{ id: "linked-member-1" }];

  const organizerMembersQuery = {
    is: vi.fn(() => ({
      then: (resolve: (value: { data: Array<{ id: string }>; error: null }) => unknown) =>
        Promise.resolve({ data: manualMembers, error: null }).then(resolve),
    })),
    not: vi.fn(() => ({
      then: (resolve: (value: { data: Array<{ id: string }>; error: null }) => unknown) =>
        Promise.resolve({ data: linkedMembers, error: null }).then(resolve),
    })),
  };

  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string) => {
        if (column === "profile_id" && membershipOrganizerId) {
          return {
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: linkedMemberId
                  ? {
                      id: linkedMemberId,
                      name: "Member Name",
                      date_of_birth: "2000-01-01",
                      likes: [],
                      dislikes: [],
                      avatar_url: null,
                    }
                  : null,
                error: null,
              })),
            })),
          };
        }

        return organizerMembersQuery;
      }),
    })),
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(async () => ({ error: null })),
        })),
      })),
    })),
    upsert: vi.fn(async () => ({ error: null })),
    delete: vi.fn(() => ({
      eq: vi.fn(() => ({
        is: vi.fn(() => ({
          in: vi.fn(async () => ({ error: null })),
        })),
      })),
    })),
  };
}

function createDietaryRestrictionsTableMock() {
  return {
    delete: vi.fn(() => ({
      eq: vi.fn(() => ({
        in: vi.fn(async () => ({ error: null })),
      })),
    })),
    insert: vi.fn(async () => ({ error: null })),
  };
}

describe("PUT /api/me", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    membershipOrganizerId = null;
    linkedMemberId = "linked-member-1";
    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    fromMock.mockImplementation((table: string) => {
      if (table === "household_memberships") {
        return createMembershipsTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_members") {
        return createHouseholdMembersTableMock();
      }
      if (table === "dietary_restrictions") {
        return createDietaryRestrictionsTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("returns 403 when a member attempts to change household name", async () => {
    membershipOrganizerId = "organizer-1";
    getUserIdFromAuthHeader.mockResolvedValue("member-1");

    const { PUT } = await import("../../src/bigtable/routes/me.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me",
        {
          householdName: "New Household Name",
          householdMembers: [
            {
              id: "linked-member-1",
              name: "Member Name",
              likes: [],
              dislikes: [],
            },
          ],
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(403);
  });

  it("allows a member to edit only their linked household member row", async () => {
    membershipOrganizerId = "organizer-1";
    getUserIdFromAuthHeader.mockResolvedValue("member-1");

    const { PUT } = await import("../../src/bigtable/routes/me.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me",
        {
          householdName: "Organizer Household",
          householdMembers: [
            {
              id: "linked-member-1",
              name: "Updated Member",
              likes: ["tacos"],
              dislikes: [],
            },
          ],
          dietaryRestrictions: [
            { type: "allergy", value: "shellfish" },
          ],
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(200);
  });

  it("returns 403 when a member payload includes another household member photo", async () => {
    membershipOrganizerId = "organizer-1";
    getUserIdFromAuthHeader.mockResolvedValue("member-1");

    const { PUT } = await import("../../src/bigtable/routes/me.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me",
        {
          householdName: "Organizer Household",
          householdMembers: [
            {
              id: "linked-member-1",
              name: "Member Name",
              avatarUrl: "member-1/new-photo.jpg",
              likes: [],
              dislikes: [],
            },
            {
              id: "someone-else",
              name: "Other Member",
              avatarUrl: "member-1/other-photo.jpg",
              likes: [],
              dislikes: [],
            },
          ],
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(403);
  });

  it("keeps organizer writes scoped to manual member rows", async () => {
    membershipOrganizerId = null;
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");

    const { PUT } = await import("../../src/bigtable/routes/me.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me",
        {
          householdName: "Organizer Household",
          householdMembers: [
            {
              id: "manual-1",
              name: "Adult One",
              likes: ["pasta"],
              dislikes: ["olives"],
            },
          ],
          dietaryRestrictions: [
            { type: "preference", value: "high protein" },
          ],
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(200);
  });

  it("returns 403 when organizer attempts to update a joined member profile row", async () => {
    membershipOrganizerId = null;
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");

    const { PUT } = await import("../../src/bigtable/routes/me.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/me",
        {
          householdName: "Organizer Household",
          householdMembers: [
            {
              id: "linked-member-1",
              name: "Joined User",
              likes: ["soup"],
              dislikes: [],
            },
          ],
          dietaryRestrictions: [],
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "You cannot edit another user's profile" });
  });
});
