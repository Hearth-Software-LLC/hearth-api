import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const insertNotification = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

let invitationStatus: "pending" | "accepted" | "declined" | "cancelled" = "pending";
let inviteeAlreadyMember = false;
let inviteeHasManagedMembers = false;

const supabaseAdmin = {
  from: fromMock,
  rpc: rpcMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/notifications.js", () => ({
  insertNotification,
}));

vi.mock("../../src/bigtable/lib/supabase.js", () => ({
  supabaseAdmin,
}));

function createInvitationsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            id: "inv-1",
            organizer_id: "organizer-1",
            invitee_id: "invitee-1",
            status: invitationStatus,
          },
          error: null,
        })),
      })),
    })),
    update: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(async () => ({ error: null })),
      })),
    })),
  };
}

function createMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string) => {
        if (column === "member_id") {
          return {
            maybeSingle: vi.fn(async () => ({
              data: inviteeAlreadyMember ? { organizer_id: "organizer-2" } : null,
              error: null,
            })),
          };
        }

        return {
          limit: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: inviteeHasManagedMembers ? { member_id: "child-1" } : null,
              error: null,
            })),
          })),
        };
      }),
    })),
  };
}

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((_: string, id: string) => ({
        maybeSingle: vi.fn(async () => ({
          data: { id, household_name: id === "invitee-1" ? "Invitee Home" : "Organizer Home" },
          error: null,
        })),
      })),
    })),
  };
}

describe("PUT /api/household/invitations/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    invitationStatus = "pending";
    inviteeAlreadyMember = false;
    inviteeHasManagedMembers = false;
    getUserIdFromAuthHeader.mockResolvedValue("invitee-1");
    rpcMock.mockResolvedValue({ data: "organizer-1", error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === "household_invitations") {
        return createInvitationsTableMock();
      }
      if (table === "household_memberships") {
        return createMembershipsTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "household_member_permissions") {
        return { upsert: vi.fn(async () => ({ error: null })) };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("accepts pending invitations for the invitee", async () => {
    const { PUT } = await import("../../src/bigtable/routes/household.invitations._id.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations/inv-1",
        { action: "accept" },
        "token",
        { method: "PUT" }
      ) as never,
      { params: Promise.resolve({ id: "inv-1" }) }
    );

    expect(response.status).toBe(200);
    expect(rpcMock).toHaveBeenCalledWith("accept_household_invitation", {
      p_invitation_id: "inv-1",
      p_invitee_id: "invitee-1",
    });
    expect(insertNotification).toHaveBeenCalled();
  });

  it("declines pending invitations for the invitee", async () => {
    const { PUT } = await import("../../src/bigtable/routes/household.invitations._id.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations/inv-1",
        { action: "decline" },
        "token",
        { method: "PUT" }
      ) as never,
      { params: Promise.resolve({ id: "inv-1" }) }
    );

    expect(response.status).toBe(200);
    expect(insertNotification).toHaveBeenCalled();
  });

  it("allows organizer to cancel pending invitations", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");

    const { PUT } = await import("../../src/bigtable/routes/household.invitations._id.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations/inv-1",
        { action: "cancel" },
        "token",
        { method: "PUT" }
      ) as never,
      { params: Promise.resolve({ id: "inv-1" }) }
    );

    expect(response.status).toBe(200);
  });

  it("returns 409 when invitee already belongs to another household", async () => {
    inviteeAlreadyMember = true;

    const { PUT } = await import("../../src/bigtable/routes/household.invitations._id.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations/inv-1",
        { action: "accept" },
        "token",
        { method: "PUT" }
      ) as never,
      { params: Promise.resolve({ id: "inv-1" }) }
    );

    await expect(response.json()).resolves.toEqual({
      error: "You are already a member of a household",
    });
    expect(response.status).toBe(409);
  });

  it("returns 409 when invitee is organizer with joined members", async () => {
    inviteeHasManagedMembers = true;

    const { PUT } = await import("../../src/bigtable/routes/household.invitations._id.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations/inv-1",
        { action: "accept" },
        "token",
        { method: "PUT" }
      ) as never,
      { params: Promise.resolve({ id: "inv-1" }) }
    );

    await expect(response.json()).resolves.toEqual({
      error: "You're the organizer of a household with joined members. Remove those members before joining another household.",
    });
    expect(response.status).toBe(409);
  });
});
