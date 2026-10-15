import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getMembershipContext = vi.fn();
const fromMock = vi.fn();

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/household.js", () => ({
  getMembershipContext,
}));

vi.mock("../../src/bigtable/lib/revenuecat.js", () => ({
  ensureRevenueCatSubscriber: vi.fn(),
  deleteRevenueCatSubscriber: vi.fn(),
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((_column: string, value: string) => ({
        maybeSingle: vi.fn(async () => {
          if (value === "organizer-1") {
            return {
              data: {
                id: "organizer-1",
                household_name: "Organizer Household",
                avatar_url: "https://img.example/organizer.png",
                created_at: "2026-01-01T00:00:00.000Z",
                social_profile_visible: true,
              },
              error: null,
            };
          }

          if (value === "member-1") {
            return {
              data: {
                id: "member-1",
                household_name: "Member Personal Name",
                avatar_url: "https://img.example/member.png",
              },
              error: null,
            };
          }

          return { data: null, error: null };
        }),
      })),
    })),
  };
}

function createHouseholdMembersTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((_column: string, value: string) => {
        if (value === "organizer-1") {
          return {
            order: vi.fn(() => ({
              then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
                Promise.resolve({
                  data: [
                    {
                      id: "organizer-member-1",
                      linked_profile_id: null,
                      name: "Organizer Main Member",
                      date_of_birth: null,
                      likes: [],
                      dislikes: [],
                      avatar_url: "https://img.example/organizer-member.png",
                      created_at: "2026-01-01T00:00:00.000Z",
                    },
                  ],
                  error: null,
                }).then(resolve),
            })),
          };
        }

        if (value === "member-1") {
          return {
            order: vi.fn(() => ({
              limit: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: null,
                  error: null,
                })),
              })),
            })),
          };
        }

        return {
          order: vi.fn(() => ({
            then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
              Promise.resolve({ data: [], error: null }).then(resolve),
          })),
        };
      }),
    })),
  };
}

function createDietaryRestrictionsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      })),
    })),
  };
}

function createHouseholdInvitationsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          then: (resolve: (value: { count: number; error: null }) => unknown) =>
            Promise.resolve({ count: 0, error: null }).then(resolve),
        })),
      })),
    })),
  };
}

describe("GET /api/me", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    getUserIdFromAuthHeader.mockResolvedValue("member-1");
    getMembershipContext.mockResolvedValue({
      role: "member",
      organizerProfileId: "organizer-1",
    });

    fromMock.mockImplementation((table: string) => {
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_members") {
        return createHouseholdMembersTableMock();
      }
      if (table === "dietary_restrictions") {
        return createDietaryRestrictionsTableMock();
      }
      if (table === "household_invitations") {
        return createHouseholdInvitationsTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("returns myMember based on the caller identity, not organizer household members", async () => {
    const { GET } = await import("../../src/bigtable/routes/me.js");
    const response = await GET(new Request("http://localhost/api/me", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);

    const payload = (await response.json()) as {
      myMember: {
        name: string | null;
      };
      householdMembers: Array<{
        name: string;
      }>;
      membership: {
        role: string;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.membership.role).toBe("member");
    expect(payload.householdMembers[0]?.name).toBe("Organizer Main Member");
    expect(payload.myMember.name).toBe("Member Personal Name");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("vary")).toContain("Authorization");
  });
});
