import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

const ORGANIZER = "00000000-0000-4000-8000-000000000001";
const ADULT = "00000000-0000-4000-8000-000000000002";
const GONE = "00000000-0000-4000-8000-000000000003";
const NEW = "00000000-0000-4000-8000-000000000004";
const KID = "00000000-0000-4000-8000-000000000005";

const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
const recent = new Date(Date.now() - 60 * 1000).toISOString();

// member_id -> { organizer, joined_at }
let memberships: Record<string, { organizer: string; joinedAt: string }> = {};

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "household_memberships" && call.op === "select") {
    const memberId = eqValue(call, "member_id");
    if (typeof memberId === "string") {
      const row = memberships[memberId];
      return { data: row ? { organizer_id: row.organizer } : null };
    }
    const organizerId = eqValue(call, "organizer_id");
    return {
      data: Object.entries(memberships)
        .filter(([, row]) => row.organizer === organizerId)
        .map(([member, row]) => ({ member_id: member, joined_at: row.joinedAt })),
    };
  }
  return { data: null };
}

function request(members: unknown) {
  return buildAuthenticatedJsonRequest("http://localhost/v1/household/members", { members });
}

describe("PUT /household/members", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    memberships = {
      [ADULT]: { organizer: ORGANIZER, joinedAt: old },
      [GONE]: { organizer: ORGANIZER, joinedAt: old },
      [NEW]: { organizer: ORGANIZER, joinedAt: recent },
      [KID]: { organizer: ORGANIZER, joinedAt: old },
    };
    fake = createFakeSupabase(respond);
    getUserIdFromAuthHeader.mockResolvedValue(ORGANIZER);
  });

  it("sets members' permissions from their household roles", async () => {
    const { PUT } = await import("../../src/bigtable/routes/household.members.js");
    const response = await PUT(request([
      { accountId: ORGANIZER, role: "parent" },
      { accountId: ADULT, role: "adult" },
      { accountId: KID, role: "kid" },
    ]));
    const body = (await response.json()) as { joined: string[] };

    expect(response.status).toBe(200);
    expect(body.joined.sort()).toEqual([ADULT, KID].sort());

    const upserts = fake.callsTo("household_member_permissions", "upsert").map((call) => call.payload as Record<string, unknown>);
    expect(upserts).toHaveLength(2);
    expect(upserts.find((row) => row.member_id === ADULT)).toMatchObject({
      can_manage_meal_plan: true, can_use_ai_meal_plan: true, can_use_ai_grocery: true, can_edit_members: false,
    });
    expect(upserts.find((row) => row.member_id === KID)).toMatchObject({
      can_manage_meal_plan: false, can_use_ai_meal_plan: false, can_use_ai_grocery: false, can_edit_members: false,
    });
  });

  it("never removes anyone (kids can't link their account, and leaving has its own route)", async () => {
    const { PUT } = await import("../../src/bigtable/routes/household.members.js");
    const response = await PUT(request([{ accountId: ADULT, role: "adult" }]));

    expect(response.status).toBe(200);
    expect(fake.rpcCalls).toEqual([]);
  });

  it("is only for the organizer", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(ADULT);
    const { PUT } = await import("../../src/bigtable/routes/household.members.js");
    const response = await PUT(request([]));

    expect(response.status).toBe(403);
    expect(fake.rpcCalls).toEqual([]);
  });

  it("rejects malformed people", async () => {
    const { PUT } = await import("../../src/bigtable/routes/household.members.js");
    expect((await PUT(request([{ accountId: "nope", role: "adult" }]))).status).toBe(400);
    expect((await PUT(request([{ accountId: ADULT, role: "boss" }]))).status).toBe(400);
    expect((await PUT(request("everyone"))).status).toBe(400);
  });

  it("needs a signed-in caller", async () => {
    getUserIdFromAuthHeader.mockResolvedValue(null);
    const { PUT } = await import("../../src/bigtable/routes/household.members.js");
    expect((await PUT(request([]))).status).toBe(401);
  });
});
