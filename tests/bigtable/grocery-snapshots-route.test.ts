import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const fromMock = vi.fn();
const supabaseAdmin = {
  from: fromMock,
};
const updateEqMock = vi.fn();
const updateNeqMock = vi.fn();
let lastInsertedSnapshot: Record<string, unknown> | null = null;
let membershipOrganizerId: string | null = null;

vi.mock("../../src/bigtable/lib/auth.js", () => ({
  getUserIdFromAuthHeader,
}));

vi.mock("../../src/services/supabase.js", () => ({
  supabaseAdmin,
}));

function createSnapshotTableMock() {
  updateNeqMock.mockResolvedValue({ error: null });
  updateEqMock.mockImplementation(() => ({
    error: null,
    neq: updateNeqMock,
  }));
  const insert = vi.fn((rows?: unknown) => ({
    select: vi.fn(() => ({
      single: vi.fn(async () => ({
        data: {
          id: "snapshot-1",
          generated_at: "2026-05-27T12:00:00.000Z",
          item_count: 1,
          estimated_cost: 23.45,
          source: "anthropic",
          is_active: true,
          sections: [
            {
              name: "Produce",
              icon: "🥬",
              items: [
                {
                  id: "item-1",
                  name: "Spinach",
                  quantity: "2 large bags for salads, egg bites, and one extra backup bag if the store only has baby spinach",
                  meals: ["Salads"],
                  bulk: false,
                },
              ],
            },
          ],
          checks: {},
        },
        error: null,
      })),
    })),
  }));

  return {
    update: vi.fn(() => ({
      eq: updateEqMock,
    })),
    insert,
  };
}

function createMembershipTableMock() {
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

describe("PUT /api/grocery/snapshots", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    lastInsertedSnapshot = null;
    membershipOrganizerId = null;
    getUserIdFromAuthHeader.mockResolvedValue("user-1");
    fromMock.mockImplementation((table: string) => {
      if (table === "grocery_snapshots") {
        const snapshotTable = createSnapshotTableMock();
        const originalInsert = snapshotTable.insert;
        snapshotTable.insert = vi.fn((rows: unknown) => {
          const payload = Array.isArray(rows) ? rows[0] : rows;
          lastInsertedSnapshot = payload as Record<string, unknown>;
          return originalInsert(rows);
        });
        return snapshotTable;
      }

      if (table === "household_memberships") {
        return createMembershipTableMock();
      }

      throw new Error(`Unexpected table: ${table}`);
    });
  });

  it("accepts longer AI-generated quantity text when publishing a snapshot", async () => {
    const { PUT } = await import("../../src/bigtable/routes/grocery.snapshots.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/grocery/snapshots",
        {
          sections: [
            {
              name: "Produce",
              icon: "🥬",
              items: [
                {
                  id: "item-1",
                  name: "Spinach",
                  quantity: "2 large bags for salads, egg bites, and one extra backup bag if the store only has baby spinach",
                  meals: ["Salads"],
                  bulk: false,
                },
              ],
            },
          ],
          checks: {},
          estimatedCost: 23.45,
          source: "anthropic",
          makeActive: true,
        },
        "token",
        { method: "PUT" }
      ) as never
    );
    const body = (await response.json()) as { snapshot?: { sections: Array<{ items: Array<{ quantity: string }> }> } };

    expect(response.status).toBe(200);
    expect(body.snapshot?.sections[0]?.items[0]?.quantity).toContain("extra backup bag");
    expect(updateNeqMock).not.toHaveBeenCalled();
  });

  it("does not compare id against an empty string when saving a new active snapshot", async () => {
    const { PUT } = await import("../../src/bigtable/routes/grocery.snapshots.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/grocery/snapshots",
        {
          sections: [
            {
              name: "Produce",
              icon: "🥬",
              items: [
                {
                  id: "item-1",
                  name: "Spinach",
                  quantity: "2 bags",
                  meals: ["Salads"],
                  bulk: false,
                },
              ],
            },
          ],
          checks: {},
          estimatedCost: 12.34,
          source: "manual",
          makeActive: true,
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(updateNeqMock).not.toHaveBeenCalledWith("id", "");
  });

  it("rejects member attempts to replace snapshot sections", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("member-1");
    membershipOrganizerId = "organizer-1";

    const { PUT } = await import("../../src/bigtable/routes/grocery.snapshots.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/grocery/snapshots",
        {
          sections: [
            {
              name: "Produce",
              icon: "🥬",
              items: [
                {
                  id: "item-1",
                  name: "Spinach",
                  quantity: "2 bags",
                  meals: ["Salads"],
                  bulk: false,
                },
              ],
            },
          ],
          checks: {},
          estimatedCost: 12.34,
          source: "manual",
          makeActive: true,
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(403);
    expect(lastInsertedSnapshot).toBeNull();
  });

  it("allows member checklist-only updates on existing snapshot", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("member-1");
    membershipOrganizerId = "organizer-1";

    fromMock.mockImplementation((table: string) => {
      if (table === "household_memberships") {
        return createMembershipTableMock();
      }

      if (table === "grocery_snapshots") {
        return {
          update: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn(() => ({
                select: vi.fn(() => ({
                  maybeSingle: vi.fn(async () => ({
                    data: {
                      id: "snapshot-1",
                      generated_at: "2026-05-27T12:00:00.000Z",
                      item_count: 1,
                      estimated_cost: 10,
                      source: "manual",
                      is_active: true,
                      sections: [
                        {
                          name: "Produce",
                          icon: "🥬",
                          items: [
                            {
                              id: "item-1",
                              name: "Spinach",
                              quantity: "2 bags",
                              meals: ["Salads"],
                              bulk: false,
                            },
                          ],
                        },
                      ],
                      checks: { "item-1": true },
                    },
                    error: null,
                  })),
                })),
              })),
            })),
          })),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    });

    const { PUT } = await import("../../src/bigtable/routes/grocery.snapshots.js");
    const response = await PUT(
      buildAuthenticatedJsonRequest(
        "http://localhost/api/grocery/snapshots",
        {
          id: "snapshot-1",
          checks: { "item-1": true },
        },
        "token",
        { method: "PUT" }
      ) as never
    );

    expect(response.status).toBe(200);
  });
});