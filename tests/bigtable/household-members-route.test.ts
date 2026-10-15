import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const insertNotification = vi.fn();
const fromMock = vi.fn();
const rpcMock = vi.fn();

let requesterId = "organizer-1";

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

function createMembershipsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        maybeSingle: vi.fn(async () => ({
          data: {
            member_id: "member-1",
            organizer_id: "organizer-1",
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
      eq: vi.fn((_: string, id: string) => ({
        maybeSingle: vi.fn(async () => ({
          data: { id, household_name: id === "member-1" ? "Member Name" : "Organizer Home" },
          error: null,
        })),
      })),
    })),
  };
}

describe("DELETE /api/household/members/[memberId]", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    requesterId = "organizer-1";
    getUserIdFromAuthHeader.mockImplementation(async () => requesterId);
    rpcMock.mockResolvedValue({ data: "organizer-1", error: null });

    fromMock.mockImplementation((table: string) => {
      if (table === "household_memberships") {
        return createMembershipsTableMock();
      }
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("notifies removed member when organizer removes them", async () => {
    const { DELETE } = await import("../../src/bigtable/routes/household.members._memberId.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/members/member-1",
        {},
        "token",
        { method: "DELETE" }
      ) as never,
      { params: Promise.resolve({ memberId: "member-1" }) }
    );

    expect(response.status).toBe(200);
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({ type: "household_member_removed" }));
  });

  it("notifies organizer when member leaves", async () => {
    requesterId = "member-1";

    const { DELETE } = await import("../../src/bigtable/routes/household.members._memberId.js");
    const response = await DELETE(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/members/member-1",
        {},
        "token",
        { method: "DELETE" }
      ) as never,
      { params: Promise.resolve({ memberId: "member-1" }) }
    );

    expect(response.status).toBe(200);
    expect(insertNotification).toHaveBeenCalledWith(expect.objectContaining({ type: "household_member_left" }));
  });
});
