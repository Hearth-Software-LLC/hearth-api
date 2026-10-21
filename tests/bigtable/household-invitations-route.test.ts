import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest, buildAuthHeader } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const getMembershipContext = vi.fn();
const insertNotification = vi.fn();
const fromMock = vi.fn();

let inviteeExists = true;
let inviteeBlockedOrganizer = false;
let existingPending = false;
let inviteeAlreadyMember = false;
let inviteeHasManagedMembers = false;
let organizerMemberCount = 0;

const supabaseAdmin = {
  from: fromMock,
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/bigtable/lib/household.js", () => ({
  getMembershipContext,
}));

vi.mock("../../src/bigtable/lib/notifications.js", () => ({
  insertNotification,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createProfilesTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((_: string, id: string) => ({
        maybeSingle: vi.fn(async () => {
          if (id === "invitee-1") {
            return {
              data: inviteeExists ? { id: "invitee-1", household_name: "Invitee Home", avatar_url: null } : null,
              error: null,
            };
          }

          return {
            data: { id, household_name: "Organizer Home", avatar_url: null },
            error: null,
          };
        }),
      })),
      in: vi.fn(() => Promise.resolve({
        data: [
          { id: "invitee-1", household_name: "Invitee Home", avatar_url: null },
          { id: "organizer-2", household_name: "Organizer Two", avatar_url: null },
        ],
        error: null,
      })),
    })),
  };
}

function createBlocksTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: inviteeBlockedOrganizer ? { blocker_id: "invitee-1" } : null,
            error: null,
          })),
        })),
      })),
    })),
  };
}

function createHouseholdInvitationsTableMock() {
  return {
    select: vi.fn(() => ({
      eq: vi.fn((column: string, value: string) => {
        if (column === "organizer_id" && value === "organizer-1") {
          return {
            eq: vi.fn((nestedColumn: string) => {
              if (nestedColumn === "invitee_id") {
                return {
                  eq: vi.fn(() => ({
                    maybeSingle: vi.fn(async () => ({
                      data: existingPending ? { id: "inv-1" } : null,
                      error: null,
                    })),
                  })),
                };
              }

              return {
                order: vi.fn(async () => ({
                  data: [
                    {
                      id: "inv-sent-1",
                      organizer_id: "organizer-1",
                      invitee_id: "invitee-1",
                      status: "pending",
                      created_at: "2026-06-01T00:00:00.000Z",
                    },
                  ],
                  error: null,
                })),
              };
            }),
          };
        }

        return {
          eq: vi.fn(() => ({
            order: vi.fn(async () => ({
              data: [
                {
                  id: "inv-recv-1",
                  organizer_id: "organizer-2",
                  invitee_id: "organizer-1",
                  status: "pending",
                  created_at: "2026-06-01T00:00:00.000Z",
                },
              ],
              error: null,
            })),
          })),
        };
      }),
    })),
    insert: vi.fn(() => ({
      select: vi.fn(() => ({
        single: vi.fn(async () => ({
          data: {
            id: "inv-new-1",
            organizer_id: "organizer-1",
            invitee_id: "invitee-1",
            status: "pending",
            created_at: "2026-06-01T00:00:00.000Z",
          },
          error: null,
        })),
      })),
    })),
  };
}

function createHouseholdMembershipsTableMock() {
  return {
    select: vi.fn((_columns?: string, opts?: { count?: string; head?: boolean }) => {
      if (opts?.head) {
        return {
          eq: vi.fn(async () => ({ count: organizerMemberCount, error: null })),
        };
      }

      return {
        eq: vi.fn((column: string) => {
          if (column === "member_id") {
            return {
              maybeSingle: vi.fn(async () => ({
                data: inviteeAlreadyMember ? { member_id: "invitee-1" } : null,
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
      };
    }),
  };
}

describe("/api/household/invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
    getMembershipContext.mockResolvedValue({ role: "organizer", organizerProfileId: "organizer-1" });

    inviteeExists = true;
    inviteeBlockedOrganizer = false;
    existingPending = false;
    inviteeAlreadyMember = false;
    inviteeHasManagedMembers = false;
    organizerMemberCount = 0;

    fromMock.mockImplementation((table: string) => {
      if (table === "profiles") {
        return createProfilesTableMock();
      }
      if (table === "blocks") {
        return createBlocksTableMock();
      }
      if (table === "household_invitations") {
        return createHouseholdInvitationsTableMock();
      }
      if (table === "household_memberships") {
        return createHouseholdMembershipsTableMock();
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("creates a pending invitation for organizer callers", async () => {
    const { POST } = await import("../../src/bigtable/routes/household.invitations.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations",
        { inviteeProfileId: "invitee-1" },
        "token",
        { method: "POST" }
      ) as never
    );
    const payload = (await response.json()) as { invitation?: { id: string } };

    expect(response.status).toBe(200);
    expect(payload.invitation?.id).toBe("inv-new-1");
    expect(insertNotification).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when invitee is managing their own household", async () => {
    inviteeHasManagedMembers = true;

    const { POST } = await import("../../src/bigtable/routes/household.invitations.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations",
        { inviteeProfileId: "invitee-1" },
        "token",
        { method: "POST" }
      ) as never
    );

    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toBe(
      "Invitee Home is the organizer of a household with joined members. They need to remove those members before they can join another household."
    );
  });

  it("returns 409 with a clear message when invitee is already in another household", async () => {
    inviteeAlreadyMember = true;

    const { POST } = await import("../../src/bigtable/routes/household.invitations.js");
    const response = await POST(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/household/invitations",
        { inviteeProfileId: "invitee-1" },
        "token",
        { method: "POST" }
      ) as never
    );
    const payload = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(payload.error).toBe(
      "Invitee Home is already a member of another household. They need to leave their current household before they can be invited to join another."
    );
  });

  it("returns sent and received pending invitations", async () => {
    const { GET } = await import("../../src/bigtable/routes/household.invitations.js");
    const response = await GET(new Request("http://localhost/api/household/invitations", {
      headers: {
        authorization: buildAuthHeader(),
      },
    }) as never);
    const payload = (await response.json()) as {
      sent: Array<{ id: string }>;
      received: Array<{ id: string }>;
    };

    expect(response.status).toBe(200);
    expect(payload.sent).toHaveLength(1);
    expect(payload.received).toHaveLength(1);
  });
});
