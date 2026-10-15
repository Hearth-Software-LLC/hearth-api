import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

let callerBlockedTarget = false;
let targetBlockedCaller = false;
let organizerMemberRows: Array<{ profile_id: string; name: string | null; avatar_url: string | null }> = [];
let linkedMemberRows: Array<{ linked_profile_id: string; name: string | null; avatar_url: string | null }> = [];
let targetSocialProfileVisible = true;
let callerOrganizerId: string | null = null;
let targetOrganizerId: string | null = null;

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

function createBlocksTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string, value: string) => ({
        eq: vi.fn((nestedColumn: string, nestedValue: string) => {
          const isCallerBlocksTarget =
            column === "blocker_id" && value === "caller-1" && nestedColumn === "blocked_id" && nestedValue === "target-1";
          const isTargetBlocksCaller =
            column === "blocker_id" && value === "target-1" && nestedColumn === "blocked_id" && nestedValue === "caller-1";

          return {
            maybeSingle: vi.fn(async () => ({
              data: isCallerBlocksTarget
                ? (callerBlockedTarget ? { blocker_id: "caller-1" } : null)
                : isTargetBlocksCaller
                  ? (targetBlockedCaller ? { blocker_id: "target-1" } : null)
                  : null,
              error: null,
            })),
          };
        }),
      })),
    })),
  };
}

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            id: "target-1",
            household_name: "Target Household",
            avatar_url: "https://img.example/avatar.png",
            created_at: "2026-01-01T00:00:00.000Z",
            social_profile_visible: targetSocialProfileVisible,
          },
          error: null,
        })),
      })),
    })),
  };
}

function createHouseholdMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((_column: string, memberId: string) => ({
        maybeSingle: vi.fn(async () => {
          if (memberId === "caller-1" && callerOrganizerId) {
            return { data: { organizer_id: callerOrganizerId }, error: null };
          }
          if (memberId === "target-1" && targetOrganizerId) {
            return { data: { organizer_id: targetOrganizerId }, error: null };
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
      eq: vi.fn((column: string, value: string) => ({
        order: vi.fn(() => ({
          limit: vi.fn(() => ({
            maybeSingle: vi.fn(async () => {
              if (column === "linked_profile_id") {
                return {
                  data: linkedMemberRows.find((row) => row.linked_profile_id === value) ?? null,
                  error: null,
                };
              }

              return {
                data: organizerMemberRows.find((row) => row.profile_id === value) ?? null,
                error: null,
              };
            }),
          })),
        })),
      })),
    })),
  };
}

function createFollowsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        then: (resolve: (value: { count: number; error: null }) => unknown) =>
          Promise.resolve({ count: 0, error: null }).then(resolve),
      })),
    })),
  };
}

function createRecipesTableMock() {
  const orderBuilder = {
    order: vi.fn(() => orderBuilder),
    then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
      Promise.resolve({ data: [], error: null }).then(resolve),
  };

  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => orderBuilder),
        })),
      })),
    })),
  };
}

describe("GET /api/profiles/[id]/public", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    callerBlockedTarget = false;
    targetBlockedCaller = false;
    organizerMemberRows = [];
    linkedMemberRows = [];
    targetSocialProfileVisible = true;
    callerOrganizerId = null;
    targetOrganizerId = null;
    getUserIdFromAuthHeader.mockResolvedValue("caller-1");

    fromMock.mockImplementation((table: string) => {
      if (table === "blocks") {
        return createBlocksTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_members") {
        return createHouseholdMembersTableMock();
      }
      if (table === "household_memberships") {
        return createHouseholdMembershipsTableMock();
      }
      if (table === "follows") {
        return createFollowsTableMock();
      }
      if (table === "recipes") {
        return createRecipesTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("still returns profile when caller has blocked target profile", async () => {
    callerBlockedTarget = true;

    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(new Request("http://localhost/api/profiles/target-1/public", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never, { params: Promise.resolve({ id: "target-1" }) });

    expect(response.status).toBe(200);
  });

  it("returns 404 when target has blocked caller", async () => {
    targetBlockedCaller = true;

    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(new Request("http://localhost/api/profiles/target-1/public", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never, { params: Promise.resolve({ id: "target-1" }) });

    expect(response.status).toBe(404);
  });

  it("falls back to profile household metadata when no household member row exists", async () => {
    organizerMemberRows = [
      {
        profile_id: "different-profile",
        name: "Unrelated Member",
        avatar_url: "https://img.example/unrelated.png",
      },
    ];

    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(new Request("http://localhost/api/profiles/target-1/public", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never, { params: Promise.resolve({ id: "target-1" }) });
    const payload = (await response.json()) as {
      profile: {
        profileName: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.profile.profileName).toBe("Target Household");
  });

  it("allows direct profile view for same-household peers when social visibility is off", async () => {
    targetSocialProfileVisible = false;
    callerOrganizerId = "organizer-1";
    targetOrganizerId = "organizer-1";

    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(new Request("http://localhost/api/profiles/target-1/public", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never, { params: Promise.resolve({ id: "target-1" }) });

    expect(response.status).toBe(200);
  });

  it("prefers linked member identity for joined users", async () => {
    linkedMemberRows = [
      {
        linked_profile_id: "target-1",
        name: "Yankee Doodle",
        avatar_url: "https://img.example/yankee.png",
      },
    ];

    const { GET } = await import("../../src/bigtable/routes/profiles._id.public.js");
    const response = await GET(new Request("http://localhost/api/profiles/target-1/public", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never, { params: Promise.resolve({ id: "target-1" }) });
    const payload = (await response.json()) as {
      profile: {
        profileName: string | null;
        avatarUrl: string | null;
      };
    };

    expect(response.status).toBe(200);
    expect(payload.profile.profileName).toBe("Yankee Doodle");
    expect(payload.profile.avatarUrl).toBe("https://img.example/yankee.png");
  });
});
