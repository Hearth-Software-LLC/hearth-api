import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();

let profilesRows: Array<Record<string, unknown>> = [];
let organizersRows: Array<Record<string, unknown>> = [];
let followsRows: Array<Record<string, unknown>> = [];
let relationRows: Array<Record<string, unknown>> = [];
let publishedRows: Array<Record<string, unknown>> = [];
let currentFollowingRows: Array<Record<string, unknown>> = [];
let blocksRows: Array<Record<string, unknown>> = [];

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve({ data: profilesRows, error: null }).then(resolve),
      })),
      in: vi.fn(() => ({
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve({ data: profilesRows, error: null }).then(resolve),
      })),
    })),
  };
}

function createHouseholdMembersTableMock() {
  return {
    select: vi.fn(() => ({
      order: vi.fn(() => ({
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve({ data: organizersRows, error: null }).then(resolve),
      })),
      in: vi.fn(() => ({
        order: vi.fn(() => ({
          then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
            Promise.resolve({ data: organizersRows, error: null }).then(resolve),
        })),
      })),
    })),
  };
}

function createFollowsTableMock() {
  return {
    select: vi.fn((columns: string) => {
      if (columns === "follower_profile_id, followee_profile_id") {
        return {
          then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
            Promise.resolve({ data: followsRows, error: null }).then(resolve),
        };
      }

      if (columns.includes("created_at")) {
        return {
          eq: vi.fn(() => ({
            order: vi.fn(() => ({
              range: vi.fn(() => Promise.resolve({ data: relationRows, error: null, count: relationRows.length })),
            })),
          })),
        };
      }

      return {
        eq: vi.fn(() => ({
          in: vi.fn(() => ({
            then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
              Promise.resolve({ data: currentFollowingRows, error: null }).then(resolve),
          })),
          then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
            Promise.resolve({ data: currentFollowingRows, error: null }).then(resolve),
        })),
      };
    }),
  };
}

function createRecipesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve({ data: publishedRows, error: null }).then(resolve),
      })),
    })),
  };
}

function createBlocksTableMock() {
  return {
    select: vi.fn(() => ({
      or: vi.fn(() => ({
        then: (resolve: (value: { data: Array<Record<string, unknown>>; error: null }) => unknown) =>
          Promise.resolve({ data: blocksRows, error: null }).then(resolve),
      })),
    })),
  };
}

describe("GET /api/follows discover", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("user-1");

    profilesRows = [
      {
        id: "user-2",
        household_name: "Household Two",
        avatar_url: "https://img.example/2.png",
        created_at: "2026-01-01T00:00:00.000Z",
        social_profile_visible: true,
      },
      {
        id: "user-3",
        household_name: "Household Three",
        avatar_url: "https://img.example/3.png",
        created_at: "2026-01-02T00:00:00.000Z",
        social_profile_visible: true,
      },
    ];
    organizersRows = [];
    followsRows = [];
    relationRows = [];
    publishedRows = [];
    currentFollowingRows = [];
    blocksRows = [];

    fromMock.mockImplementation((table: string) => {
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_members") {
        return createHouseholdMembersTableMock();
      }
      if (table === "follows") {
        return createFollowsTableMock();
      }
      if (table === "recipes") {
        return createRecipesTableMock();
      }
      if (table === "blocks") {
        return createBlocksTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("excludes only profiles that have blocked the caller", async () => {
    blocksRows = [
      { blocker_id: "user-1", blocked_id: "user-2" },
      { blocker_id: "user-3", blocked_id: "user-1" },
    ];

    const { GET } = await import("../../src/bigtable/routes/follows.js");
    const response = await GET(new Request("http://localhost/api/follows?mode=discover", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);
    const payload = (await response.json()) as { profiles: Array<{ profileId: string }> };

    expect(response.status).toBe(200);
    expect(payload.profiles).toEqual([
      expect.objectContaining({ profileId: "user-2" }),
    ]);
  });

  it("keeps visible profiles even when no household_members organizer row exists", async () => {
    organizersRows = [];

    const { GET } = await import("../../src/bigtable/routes/follows.js");
    const response = await GET(new Request("http://localhost/api/follows?mode=discover", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);
    const payload = (await response.json()) as {
      profiles: Array<{
        profileId: string;
        profileName: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.profiles).toHaveLength(2);
    expect(payload.profiles[0]?.profileName).not.toBeNull();
  });

  it("uses linked-member identity in discover results", async () => {
    organizersRows = [
      {
        profile_id: "organizer-1",
        linked_profile_id: "user-3",
        name: "Yankee Doodle",
        avatar_url: "https://img.example/yankee.png",
        sort_order: 0,
      },
    ];

    const { GET } = await import("../../src/bigtable/routes/follows.js");
    const response = await GET(new Request("http://localhost/api/follows?mode=discover", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);
    const payload = (await response.json()) as {
      profiles: Array<{ profileId: string; profileName: string | null; avatarUrl: string | null }>;
    };

    expect(response.status).toBe(200);
    const joinedProfile = payload.profiles.find((profile) => profile.profileId === "user-3");
    expect(joinedProfile).toEqual(expect.objectContaining({
      profileName: "Yankee Doodle",
      avatarUrl: "https://img.example/yankee.png",
    }));
  });

  it("uses profile fallback metadata in following mode when organizer rows are missing", async () => {
    organizersRows = [];
    relationRows = [
      {
        followee_profile_id: "user-2",
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ];

    const { GET } = await import("../../src/bigtable/routes/follows.js");
    const response = await GET(new Request("http://localhost/api/follows?mode=following", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);
    const payload = (await response.json()) as {
      profiles: Array<{
        profileId: string;
        profileName: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.profiles).toHaveLength(1);
    expect(payload.profiles[0]).toEqual(expect.objectContaining({
      profileId: "user-2",
      profileName: "Household Two",
    }));
  });
});
