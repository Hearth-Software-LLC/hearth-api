import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();
let targetIsCallerMember = false;
let callerIsTargetMember = false;

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
        maybeSingle: vi.fn(async () => ({ data: { id: "target-1" }, error: null })),
      })),
    })),
  };
}

function createBlocksTableMock() {
  return {
    upsert: vi.fn(async () => ({ error: null })),
    delete: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(async () => ({ error: null })),
      })),
    })),
  };
}

function createFollowsTableMock() {
  return {
    delete: vi.fn(() => ({
      or: vi.fn(async () => ({ error: null })),
    })),
  };
}

function createInvitationsTableMock() {
  return {
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        or: vi.fn(async () => ({ error: null })),
      })),
    })),
  };
}

function createHouseholdMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string, value: string) => ({
        eq: vi.fn((nestedColumn: string, nestedValue: string) => {
          const isTargetInCallerHousehold =
            column === "organizer_id"
            && value === "caller-1"
            && nestedColumn === "member_id"
            && nestedValue === "target-1";
          const isCallerInTargetHousehold =
            column === "organizer_id"
            && value === "target-1"
            && nestedColumn === "member_id"
            && nestedValue === "caller-1";

          return {
            maybeSingle: vi.fn(async () => ({
              data: isTargetInCallerHousehold
                ? (targetIsCallerMember ? { member_id: "target-1" } : null)
                : isCallerInTargetHousehold
                  ? (callerIsTargetMember ? { member_id: "caller-1" } : null)
                  : null,
              error: null,
            })),
          };
        }),
      })),
    })),
  };
}

describe("/api/blocks", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("caller-1");
    targetIsCallerMember = false;
    callerIsTargetMember = false;

    fromMock.mockImplementation((table: string) => {
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "blocks") {
        return createBlocksTableMock();
      }
      if (table === "follows") {
        return createFollowsTableMock();
      }
      if (table === "household_invitations") {
        return createInvitationsTableMock();
      }
      if (table === "household_memberships") {
        return createHouseholdMembershipsTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("creates block rows and cleans follows/invitations", async () => {
    const { POST } = await import("../../src/bigtable/routes/blocks.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/blocks",
        { blockedProfileId: "target-1" },
        "token",
        { method: "POST" }
      ) as never
    );

    expect(response.status).toBe(200);
  });

  it("deletes block rows for unblock", async () => {
    const { DELETE } = await import("../../src/bigtable/routes/blocks._profileId.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/blocks/target-1",
        {},
        "token",
        { method: "DELETE" }
      ) as never,
      { params: Promise.resolve({ profileId: "target-1" }) }
    );

    expect(response.status).toBe(200);
  });

  it("returns 409 when target is a member of caller's household", async () => {
    targetIsCallerMember = true;

    const { POST } = await import("../../src/bigtable/routes/blocks.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/blocks",
        { blockedProfileId: "target-1" },
        "token",
        { method: "POST" }
      ) as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You can't block someone while they are a member of your household or you are a member of theirs.",
    });
  });

  it("returns 409 when caller is a member of target's household", async () => {
    callerIsTargetMember = true;

    const { POST } = await import("../../src/bigtable/routes/blocks.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/blocks",
        { blockedProfileId: "target-1" },
        "token",
        { method: "POST" }
      ) as never
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "You can't block someone while they are a member of your household or you are a member of theirs.",
    });
  });
});
