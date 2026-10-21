import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakeSupabase, eqValue, type QueryCall, type QueryResult } from "./helpers/fake-supabase.js";
import { buildAuthenticatedJsonRequest } from "./helpers/session.js";

const getUserIdFromAuthHeader = vi.fn();
const insertNotification = vi.fn();

let fake: ReturnType<typeof createFakeSupabase>;
const supabaseAdmin = {
  from: (table: string) => fake.client.from(table),
  rpc: (fn: string, args: Record<string, unknown>) => fake.client.rpc(fn, args),
};

vi.mock("../../src/bigtable/lib/auth.js", () => ({ getUserIdFromAuthHeader }));
vi.mock("../../src/bigtable/lib/notifications.js", () => ({ insertNotification }));
vi.mock("../../src/services/supabase.js", () => ({ supabaseAdmin }));

// memberships: member_id -> organizer_id
let memberships: Record<string, string> = {};
let joinCodes: Record<string, string> = {}; // code -> organizer_id

function respond(call: QueryCall): QueryResult | undefined {
  if (call.table === "household_memberships") {
    const memberId = eqValue(call, "member_id");
    if (typeof memberId === "string") {
      return { data: memberships[memberId] ? { organizer_id: memberships[memberId] } : null };
    }
    const organizerId = eqValue(call, "organizer_id");
    const member = Object.entries(memberships).find(([, organizer]) => organizer === organizerId)?.[0];
    return { data: member ? { member_id: member } : null };
  }
  if (call.table === "bigtable_join_codes" && call.op === "select") {
    const code = eqValue(call, "code");
    if (typeof code === "string") {
      return { data: joinCodes[code] ? { organizer_id: joinCodes[code] } : null };
    }
    const organizerId = eqValue(call, "organizer_id");
    const existing = Object.entries(joinCodes).find(([, organizer]) => organizer === organizerId)?.[0];
    return { data: existing ? { code: existing } : null };
  }
  if (call.table === "blocks") {
    return { data: [] };
  }
  if (call.table === "profiles") {
    if (call.columns === "id, display_name") {
      return { data: [{ id: "joiner-1", display_name: "Sam" }] };
    }
    return { data: { id: eqValue(call, "id"), household_name: "Home" } };
  }
  return { data: null };
}

function request(path: string, payload: Record<string, unknown>) {
  return buildAuthenticatedJsonRequest(`http://localhost/v1/bigtable/household/${path}`, payload);
}

describe("POST /household/join-code", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    memberships = {};
    joinCodes = {};
    fake = createFakeSupabase(respond);
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
  });

  it("creates a URL-safe code of 24+ characters", async () => {
    const { POST } = await import("../../src/bigtable/routes/household.join-code.js");
    const response = await POST(request("join-code", {}));
    const payload = (await response.json()) as { code: string };

    expect(response.status).toBe(200);
    expect(payload.code).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    const [upsert] = fake.callsTo("bigtable_join_codes", "upsert");
    expect(upsert!.payload).toMatchObject({ organizer_id: "organizer-1", code: payload.code });
  });

  it("returns the existing code unless asked to rotate", async () => {
    joinCodes = { "existing-code-aaaaaaaaaaaaaa": "organizer-1" };
    const { POST } = await import("../../src/bigtable/routes/household.join-code.js");

    const kept = await POST(request("join-code", {}));
    expect(await kept.json()).toEqual({ code: "existing-code-aaaaaaaaaaaaaa" });
    expect(fake.callsTo("bigtable_join_codes", "upsert")).toHaveLength(0);

    const rotated = await POST(request("join-code", { rotate: true }));
    const { code } = (await rotated.json()) as { code: string };
    expect(code).not.toBe("existing-code-aaaaaaaaaaaaaa");
    expect(fake.callsTo("bigtable_join_codes", "upsert")).toHaveLength(1);
  });

  it("refuses a caller who is a member of someone else's household", async () => {
    memberships = { "organizer-1": "organizer-2" };
    const { POST } = await import("../../src/bigtable/routes/household.join-code.js");
    const response = await POST(request("join-code", {}));

    expect(response.status).toBe(409);
    expect(fake.callsTo("bigtable_join_codes")).toHaveLength(0);
  });
});

describe("POST /household/join", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    memberships = {};
    joinCodes = { "family-code-bbbbbbbbbbbbbbbb": "organizer-1" };
    fake = createFakeSupabase(respond, (call) => ({ data: call.args.p_organizer_id }));
    getUserIdFromAuthHeader.mockResolvedValue("joiner-1");
    insertNotification.mockResolvedValue(undefined);
  });

  it("joins the household, grants AI access and tells the organizer", async () => {
    const { POST } = await import("../../src/bigtable/routes/household.join.js");
    const response = await POST(request("join", { code: "family-code-bbbbbbbbbbbbbbbb" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizerProfileId: "organizer-1" });
    expect(fake.rpcCalls).toEqual([
      { fn: "bigtable_join_household", args: { p_member_id: "joiner-1", p_organizer_id: "organizer-1" } },
    ]);
    const [permissions] = fake.callsTo("household_member_permissions", "upsert");
    expect(permissions!.payload).toMatchObject({ member_id: "joiner-1", can_use_ai_meal_plan: true, can_use_ai_grocery: true });
    expect(insertNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientProfileId: "organizer-1",
        type: "household_invitation_accepted",
        actorProfileId: "joiner-1",
        data: expect.objectContaining({ memberName: "Sam" }),
      })
    );
  });

  it("is idempotent for a member of that household", async () => {
    memberships = { "joiner-1": "organizer-1" };
    const { POST } = await import("../../src/bigtable/routes/household.join.js");
    const response = await POST(request("join", { code: "family-code-bbbbbbbbbbbbbbbb" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ organizerProfileId: "organizer-1" });
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("answers 404 for an unknown code", async () => {
    const { POST } = await import("../../src/bigtable/routes/household.join.js");
    const response = await POST(request("join", { code: "nope" }));

    expect(response.status).toBe(404);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("answers 409 for the organizer's own code", async () => {
    getUserIdFromAuthHeader.mockResolvedValue("organizer-1");
    const { POST } = await import("../../src/bigtable/routes/household.join.js");
    const response = await POST(request("join", { code: "family-code-bbbbbbbbbbbbbbbb" }));

    expect(response.status).toBe(409);
    expect(fake.rpcCalls).toHaveLength(0);
  });

  it("answers 409 for a member of another household or an organizer with members", async () => {
    const { POST } = await import("../../src/bigtable/routes/household.join.js");

    memberships = { "joiner-1": "organizer-9" };
    expect((await POST(request("join", { code: "family-code-bbbbbbbbbbbbbbbb" }))).status).toBe(409);

    memberships = { "kid-1": "joiner-1" };
    expect((await POST(request("join", { code: "family-code-bbbbbbbbbbbbbbbb" }))).status).toBe(409);

    expect(fake.rpcCalls).toHaveLength(0);
  });
});
